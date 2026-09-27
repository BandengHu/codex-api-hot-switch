import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { RequestLog, Settings } from "@/lib/types"

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

// compactTelemetryFiles 每 COMPACT_EVERY_WRITES 次写入才跑一次，所以要写满一轮
// 才能真正验证"压缩顺手回收明细"这条接线是通的。
const WRITES_PER_COMPACT = 50

let appendTelemetryLog: typeof import("./telemetry-store").appendTelemetryLog
let dataDir = ""
let detailsRoot = ""

function fakeLog(index: number): RequestLog {
  return {
    id: `log-${Date.now()}-wire${String(index).padStart(4, "0")}`,
    timestamp: new Date().toISOString(),
    codexModel: "gpt-5",
    finalProviderId: "provider-1",
    finalModelId: "model-1",
    reasoning: "medium",
    statusCode: 200,
    durationMs: 12,
    rawRequest: "{}",
    rewrittenRequest: "{}",
    responseSummary: "ok",
  }
}

function fakeSettings(): Settings {
  return {
    listenAddress: "127.0.0.1",
    port: 8787,
    takeoverEnabled: false,
    defaultProviderId: "provider-1",
    defaultModelId: "model-1",
    defaultReasoning: "medium",
    auxiliaryRoutingEnabled: false,
    auxiliaryProviderId: "provider-1",
    auxiliaryModelId: "model-1",
    auxiliaryReasoning: "medium",
    codexSubagentModelSlugs: [],
    imageGenerationProviderId: "provider-1",
    imageGenerationModelId: "model-1",
    logRetentionDays: 14,
    fullRequestLoggingEnabled: true,
    webSearchMode: "builtin",
    alphaSearchMode: "auto",
    keyStorage: "file",
    floatingBallEnabled: false,
    tokenStatsResetAt: "",
  }
}

test.before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "switchgate-telemetry-prune-"))
  process.env.CODEX_HOT_SWITCH_DATA_DIR = dataDir
  detailsRoot = join(dataDir, "logs", "request-details")
  await mkdir(detailsRoot, { recursive: true })
  ;({ appendTelemetryLog } = await import("./telemetry-store"))
})

test.after(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

// 这条用例专门盯"函数写好了但没人调用"这类回归：把 compactTelemetryFiles 里的
// pruneRequestLogDetails 调用删掉，下面的过期目录就会留下来，用例立刻变红。
test("写满一轮压缩后，过期明细目录会被真的回收", async () => {
  const now = Date.now()
  const staleId = `log-${now - 30 * DAY}-stale001`
  const inflightId = `log-${now - MINUTE}-inflight`
  await mkdir(join(detailsRoot, staleId), { recursive: true })
  await mkdir(join(detailsRoot, inflightId), { recursive: true })
  const settings = fakeSettings()

  for (let index = 0; index < WRITES_PER_COMPACT; index += 1) {
    await appendTelemetryLog(fakeLog(index), settings)
  }

  const left = await readdir(detailsRoot)
  assert.equal(left.includes(staleId), false, "过期明细目录应当随压缩一起被回收")
  assert.equal(left.includes(inflightId), true, "宽限期内的在途明细不能被误删")
})
