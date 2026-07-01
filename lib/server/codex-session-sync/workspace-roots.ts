import "server-only"

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { GLOBAL_STATE_BACKUP_NAME, GLOBAL_STATE_NAME, fileExists } from "./paths"
import { openDatabase } from "./sqlite"
import { detectCanonicalStateDb } from "./paths"

interface CwdStat {
  cwd: string
  normalizedCwd: string
  count: number
  updatedAtMs: number
}

function normalizeComparablePath(value: unknown) {
  if (typeof value !== "string") return null
  let normalized = value.trim()
  if (!normalized) return null
  const extendedUnc = normalized.match(/^\\\\\?\\UNC\\(.+)$/i)
  normalized = extendedUnc ? `\\\\${extendedUnc[1]}` : normalized.replace(/^\\\\\?\\/, "")
  normalized = normalized.replace(/\//g, "\\").replace(/\\+$/, "")
  if (/^[A-Za-z]:$/.test(normalized)) normalized += "\\"
  return normalized.toLowerCase()
}

function toDesktopWorkspacePath(value: unknown) {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  if (!trimmed) return value
  const extendedUnc = trimmed.match(/^\\\\\?\\UNC\\(.+)$/i)
  if (extendedUnc) return `\\\\${extendedUnc[1]}`.replace(/\//g, "\\")
  const extendedDrive = trimmed.match(/^\\\\\?\\([A-Za-z]:)(?:[\\/](.*))?$/)
  if (extendedDrive) {
    const [, drive, rest] = extendedDrive
    return rest && rest.length > 0 ? `${drive}\\${rest.replace(/\//g, "\\")}` : `${drive}\\`
  }
  if (trimmed.startsWith("\\\\?\\")) return trimmed.slice(4).replace(/\//g, "\\")
  return value
}

function toPathArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
  }
  if (typeof value === "string" && value.trim()) return [value]
  return []
}

function dedupePaths(paths: unknown[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of paths) {
    if (typeof value !== "string") continue
    const comparable = normalizeComparablePath(value)
    if (!comparable || seen.has(comparable)) continue
    seen.add(comparable)
    result.push(value)
  }
  return result
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function resolveStoredPath(value: string, cwdStats: CwdStat[]) {
  const comparable = normalizeComparablePath(value)
  if (!comparable) return value
  const matches = cwdStats.filter((entry) => entry.normalizedCwd === comparable)
  if (matches.length === 0) return toDesktopWorkspacePath(value) as string
  matches.sort(
    (left, right) =>
      right.count - left.count ||
      right.updatedAtMs - left.updatedAtMs ||
      left.cwd.localeCompare(right.cwd),
  )
  return toDesktopWorkspacePath(matches[0].cwd) as string
}

function copyResolvedObjectKeys(input: unknown, cwdStats: CwdStat[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const resolved = resolveStoredPath(key, cwdStats)
    if (result[resolved] === undefined || resolved === key) result[resolved] = value
  }
  return result
}

export async function readThreadCwdStats(home: string) {
  const candidate = await detectCanonicalStateDb(home)
  if (!candidate) return []
  const db = await openDatabase(candidate.path, { readOnly: true })
  try {
    const rows = db
      .prepare(
        `
        SELECT
          cwd,
          COUNT(*) AS count,
          COALESCE(MAX(updated_at_ms), MAX(updated_at) * 1000, MAX(created_at_ms), MAX(created_at) * 1000, 0) AS updated_at_ms
        FROM threads
        WHERE cwd IS NOT NULL AND cwd <> ''
        GROUP BY cwd
        ORDER BY count DESC, updated_at_ms DESC, cwd
      `,
      )
      .all() as { cwd: string; count: number; updated_at_ms: number }[]
    return rows
      .map((row) => ({
        cwd: row.cwd,
        normalizedCwd: normalizeComparablePath(row.cwd) || "",
        count: Number(row.count) || 0,
        updatedAtMs: Number(row.updated_at_ms) || 0,
      }))
      .filter((row) => row.normalizedCwd)
  } finally {
    db.close()
  }
}

export async function syncWorkspaceRoots(home: string) {
  const filePath = join(home, GLOBAL_STATE_NAME)
  if (!(await fileExists(filePath))) {
    return { updated: false, updatedWorkspaceRoots: 0, savedWorkspaceRootCount: 0 }
  }
  const originalText = await readFile(filePath, "utf8")
  const state = JSON.parse(originalText) as Record<string, unknown>
  const cwdStats = await readThreadCwdStats(home)

  const existingSavedRoots = toPathArray(state["electron-saved-workspace-roots"])
  const existingProjectOrder = toPathArray(state["project-order"])
  const existingActiveRoots = toPathArray(state["active-workspace-roots"])

  const nextSavedRoots = dedupePaths(
    (existingProjectOrder.length > 0
      ? [...existingProjectOrder, ...existingSavedRoots, ...existingActiveRoots]
      : [...existingSavedRoots, ...existingActiveRoots]
    ).map((value) => resolveStoredPath(value, cwdStats)),
  )
  const nextProjectOrder = dedupePaths(
    (existingProjectOrder.length > 0
      ? [...existingProjectOrder, ...existingSavedRoots]
      : [...nextSavedRoots]
    ).map((value) => resolveStoredPath(value, cwdStats)),
  )
  const nextActiveRoots = dedupePaths(
    existingActiveRoots.map((value) => resolveStoredPath(value, cwdStats)),
  )
  const nextLabels = copyResolvedObjectKeys(state["electron-workspace-root-labels"], cwdStats)
  const openTargets =
    state["open-in-target-preferences"] &&
    typeof state["open-in-target-preferences"] === "object" &&
    !Array.isArray(state["open-in-target-preferences"])
      ? (state["open-in-target-preferences"] as Record<string, unknown>)
      : null
  const nextOpenTargets = openTargets
    ? {
        ...openTargets,
        perPath: copyResolvedObjectKeys(openTargets.perPath, cwdStats),
      }
    : state["open-in-target-preferences"]

  const originalActiveValue = state["active-workspace-roots"]
  const nextActiveValue = Array.isArray(originalActiveValue)
    ? nextActiveRoots
    : nextActiveRoots[0] ?? originalActiveValue

  const changed =
    !arraysEqual(existingSavedRoots, nextSavedRoots) ||
    !arraysEqual(existingProjectOrder, nextProjectOrder) ||
    JSON.stringify(originalActiveValue ?? null) !== JSON.stringify(nextActiveValue ?? null) ||
    JSON.stringify(state["electron-workspace-root-labels"] ?? null) !==
      JSON.stringify(nextLabels ?? null) ||
    JSON.stringify(state["open-in-target-preferences"] ?? null) !==
      JSON.stringify(nextOpenTargets ?? null)

  state["electron-saved-workspace-roots"] = nextSavedRoots
  state["project-order"] = nextProjectOrder
  state["active-workspace-roots"] = nextActiveValue
  if (nextLabels !== undefined) state["electron-workspace-root-labels"] = nextLabels
  if (nextOpenTargets !== undefined) state["open-in-target-preferences"] = nextOpenTargets

  const nextText = `${JSON.stringify(state, null, 2)}\n`
  const backupMissing = !(await fileExists(join(home, GLOBAL_STATE_BACKUP_NAME)))
  if (changed || backupMissing) {
    await writeFile(filePath, nextText, "utf8")
    await writeFile(join(home, GLOBAL_STATE_BACKUP_NAME), nextText, "utf8")
  }
  return {
    updated: changed || backupMissing,
    updatedWorkspaceRoots: Math.max(existingSavedRoots.length, nextSavedRoots.length),
    savedWorkspaceRootCount: nextSavedRoots.length,
  }
}
