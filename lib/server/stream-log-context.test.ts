import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { RequestLog, Settings } from "@/lib/types"

let dataDir = ""
let accountDir = ""

let appendTelemetryLog: typeof import("./telemetry-store").appendTelemetryLog
let runWithAccountDataDir: typeof import("./data-root").runWithAccountDataDir
let resolveDataDir: typeof import("./data-root").resolveDataDir

function fakeLog(): RequestLog {
  return {
    id: `log-${Date.now()}-streamctx`,
    timestamp: new Date().toISOString(),
    codexModel: "gpt-5",
    finalProviderId: "provider-1",
    finalModelId: "model-1",
    reasoning: "medium",
    statusCode: 200,
    durationMs: 12,
    stream: true,
    rawRequest: "{}",
    rewrittenRequest: "{}",
    responseSummary: "chat streaming response adapted",
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
  dataDir = await mkdtemp(join(tmpdir(), "switchgate-stream-log-"))
  accountDir = join(dataDir, "accounts", "acc-1")
  await mkdir(accountDir, { recursive: true })
  // 账号目录里先放一份空白状态，appendTelemetryLog 需要读到 settings
  await writeFile(
    join(accountDir, "state.json"),
    JSON.stringify({ settings: fakeSettings() }),
    "utf8",
  )

  process.env.CODEX_HOT_SWITCH_DATA_DIR = dataDir
  process.env.CODEX_HOT_SWITCH_SERVER_UI = "1"

  appendTelemetryLog = (require("./telemetry-store") as typeof import("./telemetry-store"))
    .appendTelemetryLog
  runWithAccountDataDir = (require("./data-root") as typeof import("./data-root"))
    .runWithAccountDataDir
  resolveDataDir = (require("./data-root") as typeof import("./data-root")).resolveDataDir
})

test.after(async () => {
  delete process.env.CODEX_HOT_SWITCH_SERVER_UI
  await rm(dataDir, { recursive: true, force: true })
})

test("服务器模式：离开账号上下文后写日志，必须显式带上捕获的账号目录", async () => {
  // 前提：离开账号上下文后 resolveDataDir() 会抛错。这就是线上流式日志丢失的成因。
  assert.throws(
    () => resolveDataDir(),
    /缺少账号上下文/,
    "前提：流消费结束时已经不在账号上下文中",
  )

  // 不传目录时确实会失败（旧行为），这部分保留为对照，防止有人再退回隐式解析。
  await assert.rejects(
    () => appendTelemetryLog(fakeLog(), fakeSettings()),
    /缺少账号上下文/,
    "不应再依赖流式回调里的隐式上下文",
  )

  // 真实修复路径：pipeline 在建流时捕获目录，写日志时显式传入。
  await appendTelemetryLog(fakeLog(), fakeSettings(), accountDir)

  const written = await readFile(join(accountDir, "telemetry", "request-logs.jsonl"), "utf8")
  assert.equal(written.trim().split("\n").length, 1, "流式请求结束后必须落一条日志")
})


