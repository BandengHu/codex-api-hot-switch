"use client"

import type {
  ConsoleSnapshot,
  Model,
  ModelTestResult,
  Provider,
  ProviderTestResult,
  ReasoningEffort,
  RequestLogDetail,
} from "@/lib/types"
import type {
  CodexConfigMutationResult,
  CodexConfigStatus,
} from "@/lib/codex-config-types"
import type {
  CodexDesktopPluginRepairResult,
  CodexDesktopPluginStatus,
} from "@/lib/codex-desktop-types"
import type {
  CodexDesktopModelWhitelistMutationResult,
  CodexDesktopModelWhitelistStatus,
} from "@/lib/codex-desktop-model-whitelist-types"
import type {
  CodexSessionClearBackupsResult,
  CodexSessionDeleteResult,
  CodexSessionSyncResult,
  CodexSessionSyncStatus,
} from "@/lib/codex-session-types"
import type {
  WecomBridgeMutationResult,
  WecomBridgeSettings,
  WecomBridgeStatus,
} from "@/lib/wecom-bridge-types"

function parseJsonText(text: string): unknown {
  if (!text.trim()) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function errorMessageFromBody(body: unknown): string {
  if (typeof body === "string") return body
  if (!body || typeof body !== "object") return ""
  const record = body as Record<string, unknown>
  const error = record.error
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>
    if (typeof nested.message === "string") return nested.message
    if (typeof nested.error === "string") return nested.error
  }
  if (typeof record.message === "string") return record.message
  return ""
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T
  const text = await response.text()
  const message =
    errorMessageFromBody(parseJsonText(text)) ||
    text.trim() ||
    `${response.status} ${response.statusText}`
  throw new Error(message)
}

export async function fetchConsoleSnapshot(): Promise<ConsoleSnapshot> {
  return parseResponse<ConsoleSnapshot>(
    await fetch("/api/console", { cache: "no-store" }),
  )
}

export async function fetchRequestLogDetail(id: string): Promise<RequestLogDetail> {
  return parseResponse<RequestLogDetail>(
    await fetch(`/api/logs/${encodeURIComponent(id)}`, { cache: "no-store" }),
  )
}

export async function saveConsoleSnapshot(
  snapshot: ConsoleSnapshot,
): Promise<ConsoleSnapshot> {
  return parseResponse<ConsoleSnapshot>(
    await fetch("/api/console", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    }),
  )
}

export async function updateFloatingBallSettings(
  body: {
    floatingBallEnabled?: boolean
    floatingBallPosition?: { x: number; y: number }
  },
): Promise<ConsoleSnapshot> {
  return parseResponse<ConsoleSnapshot>(
    await fetch("/api/settings/floating-ball", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: body.floatingBallEnabled,
        position: body.floatingBallPosition,
      }),
    }),
  )
}

export async function resetTokenStats(): Promise<ConsoleSnapshot> {
  return parseResponse<ConsoleSnapshot>(
    await fetch("/api/token-stats/reset", { method: "POST" }),
  )
}

export async function testProvider(provider: Provider): Promise<ProviderTestResult> {
  return parseResponse<ProviderTestResult>(
    await fetch("/api/providers/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider }),
    }),
  )
}

export async function testModel(params: {
  provider: Provider
  model: Model
  reasoning?: ReasoningEffort
}): Promise<ModelTestResult> {
  return parseResponse<ModelTestResult>(
    await fetch("/api/models/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    }),
  )
}

export async function importConsoleConfig(file: File): Promise<ConsoleSnapshot> {
  return parseResponse<ConsoleSnapshot>(
    await fetch("/api/console/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: await file.text(),
    }),
  )
}

export function exportConsoleConfig() {
  window.location.href = "/api/console/export"
}

export async function fetchCodexConfigStatus(): Promise<CodexConfigStatus> {
  return parseResponse<CodexConfigStatus>(
    await fetch("/api/codex-config", { cache: "no-store" }),
  )
}

export async function installCodexConfig(): Promise<CodexConfigMutationResult> {
  return parseResponse<CodexConfigMutationResult>(
    await fetch("/api/codex-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "install" }),
    }),
  )
}

export async function backupCurrentCodexConfig(note?: string): Promise<CodexConfigMutationResult> {
  return parseResponse<CodexConfigMutationResult>(
    await fetch("/api/codex-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "backup-current", note }),
    }),
  )
}

export async function restoreCodexConfig(backupId?: string): Promise<CodexConfigMutationResult> {
  return parseResponse<CodexConfigMutationResult>(
    await fetch("/api/codex-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restore", backupId }),
    }),
  )
}

export async function deleteCodexConfigBackups(
  backupIds: string[],
): Promise<CodexConfigMutationResult> {
  return parseResponse<CodexConfigMutationResult>(
    await fetch("/api/codex-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete-backups", backupIds }),
    }),
  )
}

export async function updateCodexConfigBackupNote(params: {
  backupId: string
  note: string
}): Promise<CodexConfigMutationResult> {
  return parseResponse<CodexConfigMutationResult>(
    await fetch("/api/codex-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "update-backup-note",
        backupId: params.backupId,
        note: params.note,
      }),
    }),
  )
}

export async function syncCodexModelCatalog(): Promise<CodexConfigMutationResult> {
  return parseResponse<CodexConfigMutationResult>(
    await fetch("/api/codex-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sync-model-catalog" }),
    }),
  )
}

export async function fetchCodexDesktopPluginStatus(): Promise<CodexDesktopPluginStatus> {
  return parseResponse<CodexDesktopPluginStatus>(
    await fetch("/api/codex-desktop/plugins", { cache: "no-store" }),
  )
}

export async function repairCodexDesktopPlugins(): Promise<CodexDesktopPluginRepairResult> {
  return parseResponse<CodexDesktopPluginRepairResult>(
    await fetch("/api/codex-desktop/plugins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "repair" }),
    }),
  )
}


export async function fetchCodexDesktopModelWhitelistStatus(): Promise<CodexDesktopModelWhitelistStatus> {
  return parseResponse<CodexDesktopModelWhitelistStatus>(
    await fetch("/api/codex-desktop/model-whitelist", { cache: "no-store" }),
  )
}

export async function injectCodexDesktopModelWhitelist(): Promise<CodexDesktopModelWhitelistMutationResult> {
  return parseResponse<CodexDesktopModelWhitelistMutationResult>(
    await fetch("/api/codex-desktop/model-whitelist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "inject" }),
    }),
  )
}

export async function launchCodexDesktopWithModelWhitelist(): Promise<CodexDesktopModelWhitelistMutationResult> {
  return parseResponse<CodexDesktopModelWhitelistMutationResult>(
    await fetch("/api/codex-desktop/model-whitelist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "launch" }),
    }),
  )
}

export async function restartCodexDesktopWithModelWhitelist(): Promise<CodexDesktopModelWhitelistMutationResult> {
  return parseResponse<CodexDesktopModelWhitelistMutationResult>(
    await fetch("/api/codex-desktop/model-whitelist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "restart" }),
    }),
  )
}
export async function fetchCodexSessionSyncStatus(): Promise<CodexSessionSyncStatus> {
  return parseResponse<CodexSessionSyncStatus>(
    await fetch("/api/codex-sessions", { cache: "no-store" }),
  )
}

export async function syncCodexSessions(): Promise<CodexSessionSyncResult> {
  return parseResponse<CodexSessionSyncResult>(
    await fetch("/api/codex-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "sync" }),
    }),
  )
}

export async function deleteCodexSessions(
  threadIds: string[],
): Promise<CodexSessionDeleteResult> {
  return parseResponse<CodexSessionDeleteResult>(
    await fetch("/api/codex-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete-many", threadIds }),
    }),
  )
}

export async function clearCodexSessionBackups(): Promise<CodexSessionClearBackupsResult> {
  return parseResponse<CodexSessionClearBackupsResult>(
    await fetch("/api/codex-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "clear-backups" }),
    }),
  )
}

export async function fetchWecomBridgeStatus(): Promise<WecomBridgeStatus> {
  return parseResponse<WecomBridgeStatus>(
    await fetch("/api/wecom-bridge", { cache: "no-store" }),
  )
}

export async function saveWecomBridgeSettings(
  settings: Partial<WecomBridgeSettings>,
): Promise<WecomBridgeMutationResult> {
  return parseResponse<WecomBridgeMutationResult>(
    await fetch("/api/wecom-bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save-settings", settings }),
    }),
  )
}

export async function startWecomBridgeServe(): Promise<WecomBridgeMutationResult> {
  return parseResponse<WecomBridgeMutationResult>(
    await fetch("/api/wecom-bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "serve-start" }),
    }),
  )
}

export async function stopWecomBridgeServe(): Promise<WecomBridgeMutationResult> {
  return parseResponse<WecomBridgeMutationResult>(
    await fetch("/api/wecom-bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "serve-stop" }),
    }),
  )
}
