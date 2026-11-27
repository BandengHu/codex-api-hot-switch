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

// 服务器模式下后台压缩没有请求上下文，resolveDataDir() 会直接抛
// “缺少账号上下文”。如果 pruneRequestLogDetails 没拿到显式 dataDir，
// 明细目录就会无限累积 —— 线上 562M 的 request-details 就是这么来的。
test("服务器模式下没有请求上下文时，压缩仍能回收过期明细目录", async () => {
  const accountDir = join(dataDir, "accounts", "a3ba8444-9e8a-450a-8bc5-a3a42704c265")
  const accountDetailsRoot = join(accountDir, "logs", "request-details")
  await mkdir(accountDetailsRoot, { recursive: true })

  const now = Date.now()
  const staleId = `log-${now - 30 * DAY}-srvstale`
  await mkdir(join(accountDetailsRoot, staleId), { recursive: true })

  const previousServerFlag = process.env.CODEX_HOT_SWITCH_SERVER_UI
  process.env.CODEX_HOT_SWITCH_SERVER_UI = "1"
  try {
    const settings = fakeSettings()
    for (let index = 0; index < WRITES_PER_COMPACT; index += 1) {
      await appendTelemetryLog(fakeLog(index), settings, accountDir)
    }
  } finally {
    if (previousServerFlag === undefined) delete process.env.CODEX_HOT_SWITCH_SERVER_UI
    else process.env.CODEX_HOT_SWITCH_SERVER_UI = previousServerFlag
  }

  const left = await readdir(accountDetailsRoot)
  assert.equal(left.includes(staleId), false, "服务器模式下过期明细目录也必须被回收")
})
