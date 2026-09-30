import "server-only"

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type {
  WecomBridgeCommandHelpItem,
  WecomBridgeDiagnosticItem,
  WecomBridgeLogs,
  WecomBridgeMutationResult,
  WecomBridgeProcessStatus,
  WecomBridgeSettings,
  WecomBridgeStatus,
} from "@/lib/wecom-bridge-types"

const DEFAULT_MAX_MESSAGE_LENGTH = 4000
const LOG_TAIL_BYTES = 80_000

const COMMAND_HELP: WecomBridgeCommandHelpItem[] = [
  { command: "/helps", description: "查看 CodexBridge 支持的全部命令和单个命令说明" },
  { command: "/status details", description: "查看线程、权限、企业微信上下文和运行状态诊断" },
  { command: "/threads", description: "列出并切换 Codex 线程" },
  { command: "/search <关键词>", description: "搜索历史线程" },
  { command: "/open <编号或线程ID>", description: "打开或绑定指定线程" },
  { command: "/model", description: "查看或切换当前模型" },
  { command: "/provider", description: "查看或切换供应商 profile" },
  { command: "/permissions", description: "查看当前待审批权限请求" },
  { command: "/allow", description: "批准最近的权限请求" },
  { command: "/deny", description: "拒绝最近的权限请求" },
  { command: "/stop", description: "停止当前 Codex 回合" },
  { command: "/retry", description: "重试最近失败或中断的回合" },
  { command: "/compact", description: "压缩当前绑定线程上下文" },
]

let serveProcess: ChildProcess | null = null
let serveStatus: WecomBridgeProcessStatus = {
  state: "idle",
  owned: false,
}

// 崩溃自动拉起控制
let manualStopRequested = false
let autoRestartCount = 0
let autoRestartTimer: ReturnType<typeof setTimeout> | null = null
let stableRunTimer: ReturnType<typeof setTimeout> | null = null
const AUTO_RESTART_MAX = 10
const AUTO_RESTART_BASE_DELAY_MS = 1000
const AUTO_RESTART_MAX_DELAY_MS = 30_000
// 进程连续存活超过该时长视为“稳定运行”，重置退避计数。
const AUTO_RESTART_STABLE_MS = 60_000

function defaultStateDir() {
  return join(homedir(), ".codexbridge")
}

function hotSwitchAppDataRoot() {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "codex-api-hot-switch",
    )
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "codex-api-hot-switch")
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "codex-api-hot-switch",
  )
}

function hotSwitchDataRoot() {
  return process.env.CODEX_HOT_SWITCH_DATA_DIR
    ? process.env.CODEX_HOT_SWITCH_DATA_DIR
    : join(hotSwitchAppDataRoot(), "data")
}

function settingsPath() {
  return join(hotSwitchDataRoot(), "wecom-bridge-settings.json")
}

function logDir() {
  return join(hotSwitchDataRoot(), "logs", "wecom-bridge")
}

function logPath(name: keyof WecomBridgeLogs) {
  return join(logDir(), `${name}.log`)
}

function defaultSettings(): WecomBridgeSettings {
  return {
    stateDir: defaultStateDir(),
    cwd: process.env.USERPROFILE || homedir(),
    enabled: false,
    botId: "",
    secret: "",
    corpId: "",
    debug: false,
    nativeApiEnabled: true,
    codexRealBin: "",
    providerProfileId: "",
    locale: "auto",
    maxMessageLength: DEFAULT_MAX_MESSAGE_LENGTH,
  }
}

function normalizeSettings(value: Partial<WecomBridgeSettings>): WecomBridgeSettings {
  const seed = defaultSettings()
  const locale = value.locale === "zh-CN" || value.locale === "en" ? value.locale : "auto"
  return {
    ...seed,
    ...value,
    stateDir: normalizePath(value.stateDir) || seed.stateDir,
    cwd: normalizePath(value.cwd) || seed.cwd,
    enabled: Boolean(value.enabled),
    botId: normalizeText(value.botId),
    secret: normalizeText(value.secret),
    corpId: normalizeText(value.corpId),
    debug: Boolean(value.debug),
    nativeApiEnabled: typeof value.nativeApiEnabled === "boolean"
      ? value.nativeApiEnabled
      : seed.nativeApiEnabled,
    codexRealBin: normalizePath(value.codexRealBin),
    providerProfileId: normalizeText(value.providerProfileId),
    locale,
    maxMessageLength: normalizePositiveInt(value.maxMessageLength, seed.maxMessageLength),
  }
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizePath(value: unknown) {
  const text = normalizeText(value)
  if (!text) return ""
  return isAbsolute(text)
    ? resolve(/* turbopackIgnore: true */ text)
    : resolve(/* turbopackIgnore: true */ hotSwitchDataRoot(), text)
}

function normalizePositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function codexBridgeVendorRoot() {
  const resourcesPath = typeof (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath === "string"
    ? (process as NodeJS.Process & { resourcesPath: string }).resourcesPath
    : ""
  const candidates = [
    join(/* turbopackIgnore: true */ process.cwd(), "integrations", "codexbridge"),
    join(/* turbopackIgnore: true */ process.cwd(), "..", "integrations", "codexbridge"),
    join(resourcesPath, "app", "integrations", "codexbridge"),
  ]
  return candidates.map((candidate) => resolve(/* turbopackIgnore: true */ candidate)).find((candidate) =>
    existsSync(/* turbopackIgnore: true */ join(candidate, "src", "cli.ts")) &&
    existsSync(/* turbopackIgnore: true */ join(candidate, "package.json")),
  ) || resolve(/* turbopackIgnore: true */ candidates[0])
}

export async function readWecomBridgeSettings() {
  try {
    const raw = await readFile(/* turbopackIgnore: true */ settingsPath(), "utf8")
    return normalizeSettings(JSON.parse(raw) as Partial<WecomBridgeSettings>)
  } catch {
    return defaultSettings()
  }
}

export async function saveWecomBridgeSettings(settings: Partial<WecomBridgeSettings>) {
  const normalized = normalizeSettings(settings)
  await mkdir(/* turbopackIgnore: true */ dirname(settingsPath()), { recursive: true })
  await writeFile(
    /* turbopackIgnore: true */ settingsPath(),
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8",
  )
  return normalized
}

function serveLockPath(settings: WecomBridgeSettings) {
  return join(settings.stateDir, "runtime", "wecom-serve.lock")
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(/* turbopackIgnore: true */ filePath, "utf8")) as T
  } catch {
    return null
  }
}

function readTextTail(filePath: string) {
  if (!existsSync(/* turbopackIgnore: true */ filePath)) return ""
  try {
    const buffer = readFileSync(/* turbopackIgnore: true */ filePath)
    return buffer.subarray(Math.max(0, buffer.length - LOG_TAIL_BYTES)).toString("utf8")
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function readLogs(): WecomBridgeLogs {
  return {
    serveOut: readTextTail(logPath("serveOut")),
    serveErr: readTextTail(logPath("serveErr")),
  }
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function reconcileServeStatus(settings: WecomBridgeSettings): WecomBridgeProcessStatus {
  if (serveProcess?.pid && !serveProcess.killed) return serveStatus
  const lock = readJsonFile<{ pid?: unknown; startedAt?: unknown; cwd?: unknown }>(
    serveLockPath(settings),
  )
  const pid = Number(lock?.pid)
  if (isProcessAlive(pid)) {
    return {
      state: "external-running",
      owned: false,
      pid,
      startedAt: normalizeText(lock?.startedAt),
      message: "检测到企业微信机器人服务已经由外部进程运行",
    }
  }
  return serveStatus
}

function commandPreview(settings: WecomBridgeSettings) {
  const root = codexBridgeVendorRoot()
  const tsxImport = resolveTsxImportSpecifier()
  return [
    `${process.execPath} --import ${tsxImport} ${join(root, "src", "cli.ts")} wecom serve --state-dir ${settings.stateDir} --cwd ${settings.cwd} --bot-id ${settings.botId ? "[已配置]" : "[未配置]"} --secret [隐藏]`,
  ]
}

function buildEnv(settings: WecomBridgeSettings) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEXBRIDGE_STATE_DIR: settings.stateDir,
    CODEXBRIDGE_DEFAULT_CWD: settings.cwd,
    CODEX_NATIVE_API_ENABLE: settings.nativeApiEnabled ? "1" : "0",
    WECOM_BOT_ID: settings.botId,
    WECOM_SECRET: settings.secret,
    WECOM_MAX_MESSAGE_LENGTH: String(settings.maxMessageLength),
  }
  setOptionalEnv(env, "CODEXBRIDGE_DEBUG_WECOM", settings.debug ? "1" : "")
  setOptionalEnv(env, "CODEX_REAL_BIN", settings.codexRealBin || process.env.CODEX_REAL_BIN)
  setOptionalEnv(env, "CODEX_DEFAULT_PROVIDER_PROFILE_ID", settings.providerProfileId || process.env.CODEX_DEFAULT_PROVIDER_PROFILE_ID)
  setOptionalEnv(env, "CODEX_NATIVE_API_PROVIDER_PROFILE_ID", settings.providerProfileId || process.env.CODEX_NATIVE_API_PROVIDER_PROFILE_ID)
  setOptionalEnv(env, "CODEXBRIDGE_LOCALE", settings.locale === "auto" ? process.env.CODEXBRIDGE_LOCALE : settings.locale)
  setOptionalEnv(env, "WECOM_CORP_ID", settings.corpId)
  return env
}

function setOptionalEnv(env: NodeJS.ProcessEnv, key: string, value: unknown) {
  const text = normalizeText(value)
  if (text) env[key] = text
  else delete env[key]
}

function spawnCodexBridge(settings: WecomBridgeSettings) {
  const root = codexBridgeVendorRoot()
  if (!existsSync(/* turbopackIgnore: true */ join(root, "src", "cli.ts"))) {
    throw new Error(`缺少 CodexBridge 源码：${root}`)
  }
  mkdirSync(/* turbopackIgnore: true */ logDir(), { recursive: true })
  mkdirSync(/* turbopackIgnore: true */ settings.stateDir, { recursive: true })
  const stdout = createWriteStream(/* turbopackIgnore: true */ logPath("serveOut"), { flags: "a", encoding: "utf8" })
  const stderr = createWriteStream(/* turbopackIgnore: true */ logPath("serveErr"), { flags: "a", encoding: "utf8" })
  const tsxImport = resolveTsxImportSpecifier()
  const args = ["wecom", "serve", "--state-dir", settings.stateDir, "--cwd", settings.cwd]
  const child = spawn(process.execPath, ["--import", tsxImport, join(root, "src", "cli.ts"), ...args], {
    cwd: root,
    env: buildEnv(settings),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  const startLine = `\n${new Date().toISOString()} $ ${process.execPath} --import ${tsxImport} src/cli.ts ${args.join(" ")} --bot-id [env] --secret [env]\n`
  stdout.write(startLine)
  child.stdout?.on("data", (chunk) => {
    stdout.write(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk))
  })
  child.stderr?.on("data", (chunk) => {
    stderr.write(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk))
  })
  child.once("close", () => {
    stdout.end()
    stderr.end()
  })
  return child
}

function resolveTsxLoaderPath() {
  const candidates = [
    join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "tsx", "dist", "loader.mjs"),
    join(/* turbopackIgnore: true */ process.cwd(), "vendor", "tsx", "dist", "loader.mjs"),
    join(/* turbopackIgnore: true */ process.cwd(), "..", "node_modules", "tsx", "dist", "loader.mjs"),
    join(/* turbopackIgnore: true */ process.cwd(), "..", "vendor", "tsx", "dist", "loader.mjs"),
  ]
  const found = candidates.find((candidate) => existsSync(/* turbopackIgnore: true */ candidate))
  return found || "tsx"
}

function resolveTsxImportSpecifier() {
  const loader = resolveTsxLoaderPath()
  if (loader === "tsx" || loader.startsWith("file:")) return loader
  return pathToFileUrl(loader)
}

function pathToFileUrl(filePath: string) {
  return pathToFileURL(resolve(/* turbopackIgnore: true */ filePath)).href
}

function buildDiagnostics(
  settings: WecomBridgeSettings,
  available: boolean,
  vendorRoot: string,
  serve: WecomBridgeProcessStatus,
): WecomBridgeDiagnosticItem[] {
  const tsxImport = resolveTsxImportSpecifier()
  const codexBin = settings.codexRealBin || findCommandOnPath("codex")
  return [
    {
      key: "vendor",
      label: "CodexBridge 源码",
      state: available ? "ok" : "error",
      detail: available ? vendorRoot : `未找到 src/cli.ts：${vendorRoot}`,
    },
    {
      key: "credentials",
      label: "企业微信凭据",
      state: settings.botId && settings.secret ? "ok" : "error",
      detail: settings.botId && settings.secret ? "Bot ID / Secret 已配置" : "缺少 Bot ID 或 Secret",
    },
    {
      key: "tsx",
      label: "tsx loader",
      state: tsxImport === "tsx" ? "warn" : "ok",
      detail: tsxImport === "tsx" ? "未找到本地 tsx loader，将依赖 PATH 解析" : tsxImport,
    },
    {
      key: "codex",
      label: "Codex 可执行文件",
      state: codexBin ? "ok" : "warn",
      detail: codexBin || "未指定 codexRealBin，PATH 中也未找到 codex",
    },
    {
      key: "serve",
      label: "企业微信服务",
      state: serve.state === "running" || serve.state === "external-running"
        ? "ok"
        : serve.state === "failed" ? "error" : "warn",
      detail: serve.message || STATE_DETAIL[serve.state] || serve.state,
    },
  ]
}

const STATE_DETAIL: Record<string, string> = {
  idle: "服务未启动",
  starting: "服务启动中",
  running: "服务运行中",
  stopping: "服务停止中",
  exited: "服务已退出",
  failed: "服务异常退出",
  "external-running": "检测到外部服务进程",
}

function findCommandOnPath(command: string) {
  const result = process.platform === "win32"
    ? spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", [command], { encoding: "utf8" })
  if (result.status !== 0) return ""
  return normalizeText(result.stdout.split(/\r?\n/u)[0])
}

function buildStatus(settings: WecomBridgeSettings): WecomBridgeStatus {
  const vendorRoot = codexBridgeVendorRoot()
  const available = existsSync(/* turbopackIgnore: true */ join(vendorRoot, "src", "cli.ts"))
  const serve = reconcileServeStatus(settings)
  return {
    available,
    vendorRoot,
    settings: {
      ...settings,
      secret: settings.secret ? "********" : "",
    },
    serve,
    logs: readLogs(),
    paths: {
      settingsPath: settingsPath(),
      serveLockPath: serveLockPath(settings),
      logDir: logDir(),
    },
    commands: commandPreview(settings),
    diagnostics: buildDiagnostics(settings, available, vendorRoot, serve),
    commandHelp: COMMAND_HELP,
    error: available ? undefined : `缺少 CodexBridge 源码：${vendorRoot}`,
  }
}

export async function getWecomBridgeStatus(): Promise<WecomBridgeStatus> {
  return buildStatus(await readWecomBridgeSettings())
}

export async function updateWecomBridgeSettings(
  nextSettings: Partial<WecomBridgeSettings>,
): Promise<WecomBridgeMutationResult> {
  const current = await readWecomBridgeSettings()
  const next = {
    ...current,
    ...nextSettings,
  }
  if (nextSettings.secret === "********") {
    next.secret = current.secret
  }
  const settings = await saveWecomBridgeSettings(next)
  return {
    ok: true,
    message: "企业微信机器人设置已保存",
    status: buildStatus(settings),
  }
}

function clearStableRunTimer() {
  if (stableRunTimer) {
    clearTimeout(stableRunTimer)
    stableRunTimer = null
  }
}

function clearAutoRestartTimer() {
  if (autoRestartTimer) {
    clearTimeout(autoRestartTimer)
    autoRestartTimer = null
  }
}

// 启动子进程并挂上 exit/error 事件；异常退出时按指数退避自动拉起。
function launchServeProcess(settings: WecomBridgeSettings) {
  const child = spawnCodexBridge(settings)
  serveProcess = child
  serveStatus = {
    ...serveStatus,
    state: "running",
    owned: true,
    pid: child.pid,
    startedAt: serveStatus.startedAt || new Date().toISOString(),
    message: `企业微信机器人服务运行中，工作目录：${settings.cwd}`,
    autoRestarts: autoRestartCount,
  }
  // 进程稳定存活一段时间后，认为崩溃风暴已过，重置退避计数。
  clearStableRunTimer()
  stableRunTimer = setTimeout(() => {
    autoRestartCount = 0
  }, AUTO_RESTART_STABLE_MS)
  stableRunTimer.unref?.()

  const onTerminate = (code: number | null, signal: NodeJS.Signals | null, error?: unknown) => {
    if (serveProcess !== child) return
    serveProcess = null
    clearStableRunTimer()
    const exitedAt = new Date().toISOString()
    if (manualStopRequested) {
      // 用户主动停止：不自动拉起。
      serveStatus = {
        ...serveStatus,
        state: code === 0 || signal === "SIGTERM" || signal === "SIGINT" ? "exited" : "failed",
        exitCode: code,
        signal,
        exitedAt,
        message: error
          ? error instanceof Error ? error.message : String(error)
          : "企业微信机器人服务已停止",
      }
      return
    }
    if (code === 0) {
      // 正常退出（非崩溃）：不拉起。
      serveStatus = {
        ...serveStatus,
        state: "exited",
        exitCode: code,
        signal,
        exitedAt,
        message: "企业微信机器人服务已停止",
      }
      return
    }
    // 异常退出：尝试自动拉起。
    if (autoRestartCount >= AUTO_RESTART_MAX) {
      serveStatus = {
        ...serveStatus,
        state: "failed",
        exitCode: code,
        signal,
        exitedAt,
        autoRestarts: autoRestartCount,
        message: `企业微信机器人服务连续异常退出 ${autoRestartCount} 次，已停止自动拉起，请检查配置或日志`,
      }
      return
    }
    const delay = Math.min(
      AUTO_RESTART_MAX_DELAY_MS,
      AUTO_RESTART_BASE_DELAY_MS * 2 ** autoRestartCount,
    )
    autoRestartCount += 1
    serveStatus = {
      ...serveStatus,
      state: "starting",
      exitCode: code,
      signal,
      exitedAt,
      autoRestarts: autoRestartCount,
      message: `企业微信机器人服务异常退出，${Math.round(delay / 1000)} 秒后第 ${autoRestartCount} 次自动拉起`,
    }
    scheduleAutoRestart(delay)
  }

  child.once("exit", (code, signal) => onTerminate(code, signal))
  child.once("error", (error) => onTerminate(null, null, error))
}

function scheduleAutoRestart(delay: number) {
  clearAutoRestartTimer()
  autoRestartTimer = setTimeout(() => {
    autoRestartTimer = null
    if (manualStopRequested || serveProcess) return
    void (async () => {
      try {
        const settings = await readWecomBridgeSettings()
        if (!settings.enabled || !settings.botId || !settings.secret) return
        if (manualStopRequested || serveProcess) return
        launchServeProcess(settings)
      } catch (error) {
        serveStatus = {
          ...serveStatus,
          state: "failed",
          message: `自动拉起失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    })()
  }, delay)
  autoRestartTimer.unref?.()
}

export async function autostartWecomBridgeServeIfEnabled() {
  const settings = await readWecomBridgeSettings()
  if (!settings.enabled || !settings.botId || !settings.secret) return
  if (serveProcess?.pid && !serveProcess.killed) return
  if (autoRestartTimer) return
  const reconciled = reconcileServeStatus(settings)
  if (reconciled.state === "external-running") {
    serveStatus = reconciled
    return
  }
  if (["running", "starting", "stopping"].includes(reconciled.state)) return
  manualStopRequested = false
  autoRestartCount = 0
  serveStatus = {
    state: "starting",
    owned: true,
    startedAt: new Date().toISOString(),
    message: "正在随 SwitchGate 启动企业微信机器人服务",
  }
  launchServeProcess(settings)
}

export async function startWecomBridgeServe(): Promise<WecomBridgeMutationResult> {
  // (auto-restart helpers defined above)
  const settings = await readWecomBridgeSettings()
  if (!settings.botId || !settings.secret) {
    throw new Error("请先填写 Bot ID 和 Secret")
  }
  if (serveProcess?.pid && !serveProcess.killed) {
    return {
      ok: true,
      message: "企业微信机器人服务已经在运行",
      status: buildStatus(settings),
    }
  }
  const reconciled = reconcileServeStatus(settings)
  if (reconciled.state === "external-running") {
    serveStatus = reconciled
    return {
      ok: true,
      message: "检测到已有外部企业微信机器人服务，不重复启动",
      status: buildStatus(settings),
    }
  }
  const enabledSettings = await saveWecomBridgeSettings({ ...settings, enabled: true })
  manualStopRequested = false
  autoRestartCount = 0
  serveStatus = {
    state: "starting",
    owned: true,
    startedAt: new Date().toISOString(),
    message: "正在启动企业微信机器人服务",
  }
  launchServeProcess(enabledSettings)
  return {
    ok: true,
    message: "已启动企业微信机器人服务",
    status: buildStatus(enabledSettings),
  }
}

export async function stopWecomBridgeServe(): Promise<WecomBridgeMutationResult> {
  const settings = await readWecomBridgeSettings()
  const disabledSettings = await saveWecomBridgeSettings({ ...settings, enabled: false })
  // 标记为用户主动停止，取消任何待执行的自动拉起。
  manualStopRequested = true
  autoRestartCount = 0
  clearAutoRestartTimer()
  clearStableRunTimer()
  if (serveProcess?.pid && !serveProcess.killed) {
    serveStatus = { ...serveStatus, state: "stopping", message: "正在停止企业微信机器人服务" }
    serveProcess.kill()
  } else {
    serveStatus = {
      ...serveStatus,
      state: "idle",
      owned: false,
      message: "没有由 SwitchGate 启动的企业微信机器人服务",
    }
  }
  return {
    ok: true,
    message: "已请求停止企业微信机器人服务",
    status: buildStatus(disabledSettings),
  }
}

export function wecomBridgeLogFiles() {
  return {
    serveOut: logPath("serveOut"),
    serveErr: logPath("serveErr"),
  }
}

export function wecomBridgeVendorLabel() {
  const root = codexBridgeVendorRoot()
  return basename(root)
}
