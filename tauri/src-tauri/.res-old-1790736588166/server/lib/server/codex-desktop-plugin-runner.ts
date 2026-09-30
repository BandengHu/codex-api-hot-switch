import "server-only"

import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import type {
  CodexDesktopPluginRepairResult,
  CodexDesktopPluginStatus,
} from "@/lib/codex-desktop-types"

const execFileAsync = promisify(execFile)
const RUNNER_TIMEOUT_MS = 120_000

function runnerPath() {
  return join(process.cwd(), "scripts", "codex-desktop-plugins-runner.cjs")
}

async function runCodexDesktopPluginAction<T>(action: "status" | "repair"): Promise<T> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [runnerPath(), action], {
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: RUNNER_TIMEOUT_MS,
      windowsHide: true,
    })
    return JSON.parse(stdout.trim()) as T
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException & {
      stderr?: string
      stdout?: string
    }
    const detail = maybeError.stderr?.trim() || maybeError.stdout?.trim() || maybeError.message
    throw new Error(detail || "Codex 桌面端插件修复脚本执行失败")
  }
}

export function getCodexDesktopPluginStatus(): Promise<CodexDesktopPluginStatus> {
  return runCodexDesktopPluginAction<CodexDesktopPluginStatus>("status")
}

export function repairCodexDesktopPlugins(): Promise<CodexDesktopPluginRepairResult> {
  return runCodexDesktopPluginAction<CodexDesktopPluginRepairResult>("repair")
}
