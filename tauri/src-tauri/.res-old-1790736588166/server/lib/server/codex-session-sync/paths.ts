import "server-only"

import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const STATE_DB_NAME = "state_5.sqlite"
export const SQLITE_DIR_NAME = "sqlite"
export const GLOBAL_STATE_NAME = ".codex-global-state.json"
export const GLOBAL_STATE_BACKUP_NAME = ".codex-global-state.json.bak"
export const SESSION_DIR_NAMES = ["sessions", "archived_sessions"] as const

export function codexHome() {
  return process.env.CODEX_HOME || join(process.env.USERPROFILE || homedir(), ".codex")
}

export function backupRoot(home = codexHome()) {
  return join(home, "backups_state", "provider-sync")
}

export function stateDbCandidates(home = codexHome()) {
  return [
    {
      path: join(home, SQLITE_DIR_NAME, STATE_DB_NAME),
      source: "sqlite-dir" as const,
    },
    {
      path: join(home, STATE_DB_NAME),
      source: "legacy-root" as const,
    },
  ]
}

export async function fileExists(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export async function detectCanonicalStateDb(home = codexHome()) {
  for (const candidate of stateDbCandidates(home)) {
    if (await fileExists(candidate.path)) return candidate
  }
  return null
}
