import "server-only"

import { execFile } from "node:child_process"
import { readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { ensureParentDir, hotSwitchDataDir } from "@/lib/server/state-store"
import {
  normalizeAtRestSecret,
  parseAtRestKeyPayload,
  WorkbuddyAtRestError,
  type WorkbuddyAtRestKey,
} from "./at-rest"

/**
 * 取 WorkBuddy 的 at-rest 静态钥（构建期 payload 里的 `atRestSecretKey`）。
 *
 * 这把钥只存在于桌面端 native（`electron_browser_workbuddy_storage.loggerGet()`），
 * 安装目录、配置目录、注册表、环境变量里都没有副本；桌面端自己把它交给同机的
 * sidecar 时也只走 per-spawn 的私有管道 + 一次性 ticket。所以本机唯一的来源是
 * 桌面端主进程内存里那份 payload JSON —— 由同用户进程读自己的内存，不越权。
 *
 * 解析顺序（都要求 keyId 与信封一致，不一致就继续往下找）：
 *   1. 进程内缓存            同一次运行内只解一次
 *   2. WORKBUDDY_AT_REST_KEY 显式覆盖，值可以是密钥串或整份 payload JSON
 *   3. 数据目录里的缓存文件  进程重启后免去一次内存扫描
 *   4. 扫描 WorkBuddy 进程   见 scripts/workbuddy-at-rest-key.ps1
 */

const ENV_KEY_NAME = "WORKBUDDY_AT_REST_KEY"
const CACHE_FILE_NAME = "workbuddy-at-rest-key.json"
const SCAN_SCRIPT_NAME = "workbuddy-at-rest-key.ps1"
const SCAN_SECRET_PREFIX = "WB_AT_REST_SECRET="
const SCAN_TIMEOUT_MS = 90_000
const SCAN_MAX_BUFFER = 1024 * 1024

const execFileAsync = promisify(execFile)

let cachedKey: WorkbuddyAtRestKey | undefined

export function workbuddyAtRestKeyCachePath() {
  return join(hotSwitchDataDir(), CACHE_FILE_NAME)
}

export async function resolveWorkbuddyAtRestKey(expectedKeyId: string): Promise<WorkbuddyAtRestKey> {
  if (cachedKey?.keyId === expectedKeyId) return cachedKey

  const rejected: string[] = []

  const fromEnv = await trySecret(process.env[ENV_KEY_NAME], "环境变量 WORKBUDDY_AT_REST_KEY", expectedKeyId, rejected)
  if (fromEnv) return fromEnv

  const fromCache = await trySecret(await readCachedSecret(), "本机 at-rest 密钥缓存", expectedKeyId, rejected)
  if (fromCache) return fromCache

  const scanned = await scanSecretFromWorkbuddyProcess(expectedKeyId, rejected)
  if (scanned) {
    await writeCachedSecret(scanned)
    return scanned
  }

  throw new WorkbuddyAtRestError(
    [
      "WorkBuddy 本机登录态里的字段已被新版桌面端加密（$wbEncrypted），但没取到解密钥。",
      ...rejected.map((reason) => `- ${reason}`),
      "启动一次 WorkBuddy 桌面端（保持已登录）再重试即可：中转会从它的进程里取到构建期 at-rest 密钥并缓存到本机，之后不用再开着 WorkBuddy；",
      `也可以把密钥写进 ${workbuddyAtRestKeyCachePath()} 的 secret 字段，或设置环境变量 ${ENV_KEY_NAME}。`,
    ].join("\n"),
  )
}

async function trySecret(
  raw: string | undefined,
  source: string,
  expectedKeyId: string,
  rejected: string[],
): Promise<WorkbuddyAtRestKey | undefined> {
  const text = raw?.trim()
  if (!text) return undefined
  let key: WorkbuddyAtRestKey
  try {
    key = normalizeAtRestSecret(parseAtRestKeyPayload(text))
  } catch (error) {
    rejected.push(`${source}不可用：${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  if (key.keyId !== expectedKeyId) {
    rejected.push(`${source}的 keyId=${key.keyId}，与登录态信封要求的 ${expectedKeyId} 不一致`)
    return undefined
  }
  cachedKey = key
  return key
}

async function readCachedSecret(): Promise<string | undefined> {
  try {
    const raw = await readFile(workbuddyAtRestKeyCachePath(), "utf8")
    const parsed = JSON.parse(raw) as { secret?: unknown }
    return typeof parsed.secret === "string" ? parsed.secret : undefined
  } catch {
    return undefined
  }
}

async function writeCachedSecret(key: WorkbuddyAtRestKey) {
  const path = workbuddyAtRestKeyCachePath()
  try {
    await ensureParentDir(path)
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
    const payload = {
      version: 1,
      keyId: key.keyId,
      secret: key.secret,
      source: "workbuddy-process",
      updatedAt: new Date().toISOString(),
    }
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    await rename(tempPath, path)
  } catch {
    // 缓存只是省一次内存扫描，写不进去不影响本次解密。
  }
}

async function scanSecretFromWorkbuddyProcess(
  expectedKeyId: string,
  rejected: string[],
): Promise<WorkbuddyAtRestKey | undefined> {
  if (process.platform !== "win32") {
    rejected.push("自动取钥只实现了 Windows（WorkBuddy 桌面端也只跑在 Windows/macOS 上）")
    return undefined
  }
  let stdout: string
  let stderr: string
  try {
    const result = await runScanScript(expectedKeyId)
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    rejected.push(`扫描 WorkBuddy 进程内存失败：${describeCommandError(error)}`)
    return undefined
  }
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(SCAN_SECRET_PREFIX))
  if (!line) {
    rejected.push(
      `扫描 WorkBuddy 进程内存没有找到 at-rest 密钥${stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ""}`,
    )
    return undefined
  }
  return trySecret(line.slice(SCAN_SECRET_PREFIX.length), "进程内存里的 at-rest 密钥", expectedKeyId, rejected)
}

function describeCommandError(error: unknown) {
  const detail = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean }
  if (detail.code === "ENOENT") return "本机既没有 pwsh 也没有 powershell.exe"
  if (detail.killed) return `扫描 WorkBuddy 进程内存超过 ${SCAN_TIMEOUT_MS / 1000} 秒被终止`
  // 脚本自己写的 stderr 就是最准确的失败原因。execFile 的 message 会把整条命令行和这段
  // stderr 再拼一遍，用它会把同一句原因重复显示三遍并夹进命令行。
  const reported = detail.stderr?.trim() || detail.stdout?.trim()
  if (reported) return reported.slice(0, 500)
  return detail.code ? `启动扫描进程失败：${detail.code}` : "未知错误"
}

/**
 * 优先 pwsh，没有才退回系统自带的 Windows PowerShell：
 * 只按 "可执行文件是否存在" 决定用哪个，脚本本身与结果失败都不触发换壳重试。
 */
async function runScanScript(expectedKeyId: string) {
  const scriptPath = join(process.cwd(), "scripts", SCAN_SCRIPT_NAME)
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-ExpectedKeyId",
    expectedKeyId,
  ]
  let lastMissing: NodeJS.ErrnoException | undefined
  for (const shell of ["pwsh", "powershell.exe"]) {
    try {
      const result = await execFileAsync(shell, args, {
        env: process.env,
        maxBuffer: SCAN_MAX_BUFFER,
        timeout: SCAN_TIMEOUT_MS,
        windowsHide: true,
      })
      return { stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        lastMissing = error as NodeJS.ErrnoException
        continue
      }
      throw error
    }
  }
  throw lastMissing ?? new Error("找不到可用的 PowerShell")
}
