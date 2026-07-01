import "server-only"

import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import type {
  CodexDesktopModelWhitelistMutationResult,
  CodexDesktopModelWhitelistStatus,
} from "@/lib/codex-desktop-model-whitelist-types"
import type { Settings } from "@/lib/types"

const execFileAsync = promisify(execFile)
const RUNNER_TIMEOUT_MS = 120_000
const DEBUG_PORT = 9229

function runnerPath() {
  return join(process.cwd(), "scripts", "codex-desktop-model-whitelist-runner.cjs")
}

function relayBaseUrl(settings: Settings) {
  const host = settings.listenAddress === "0.0.0.0" ? "127.0.0.1" : settings.listenAddress
  return `http://${host}:${settings.port}`
}

async function runCodexDesktopModelWhitelistAction<T>(
  action: "status" | "inject" | "launch" | "restart",
  settings: Settings,
): Promise<T> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        runnerPath(),
        action,
        "--debug-port",
        String(DEBUG_PORT),
        "--relay-base-url",
        relayBaseUrl(settings),
      ],
      {
        env: process.env,
        maxBuffer: 1024 * 1024,
        timeout: RUNNER_TIMEOUT_MS,
        windowsHide: true,
      },
    )
    return JSON.parse(stdout.trim()) as T
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException & {
      stderr?: string
      stdout?: string
    }
    const detail = maybeError.stderr?.trim() || maybeError.stdout?.trim() || maybeError.message
    throw new Error(detail || "Codex 桌面端模型白名单脚本执行失败")
  }
}

export function getCodexDesktopModelWhitelistStatus(
  settings: Settings,
): Promise<CodexDesktopModelWhitelistStatus> {
  return runCodexDesktopModelWhitelistAction<CodexDesktopModelWhitelistStatus>("status", settings)
}

export function injectCodexDesktopModelWhitelist(
  settings: Settings,
): Promise<CodexDesktopModelWhitelistMutationResult> {
  return runCodexDesktopModelWhitelistAction<CodexDesktopModelWhitelistMutationResult>(
    "inject",
    settings,
  )
}

export function launchCodexDesktopWithModelWhitelist(
  settings: Settings,
): Promise<CodexDesktopModelWhitelistMutationResult> {
  return runCodexDesktopModelWhitelistAction<CodexDesktopModelWhitelistMutationResult>(
    "launch",
    settings,
  )
}

export function restartCodexDesktopWithModelWhitelist(
  settings: Settings,
): Promise<CodexDesktopModelWhitelistMutationResult> {
  return runCodexDesktopModelWhitelistAction<CodexDesktopModelWhitelistMutationResult>(
    "restart",
    settings,
  )
}
