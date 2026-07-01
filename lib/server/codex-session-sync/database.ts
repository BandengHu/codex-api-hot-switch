import "server-only"

import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import type {
  CodexSessionDatabaseStatus,
  CodexSessionItem,
} from "@/lib/codex-session-types"
import { backupRoot, detectCanonicalStateDb, fileExists, stateDbCandidates } from "./paths"
import { openDatabase, type SqliteDatabase } from "./sqlite"

type ThreadRow = Record<string, unknown> & {
  id: string
  rollout_path: string
  created_at?: number
  updated_at?: number
  source?: string
  model_provider?: string
  cwd?: string
  title?: string
  sandbox_policy?: string
  approval_mode?: string
  tokens_used?: number
  has_user_event?: number
  archived?: number
  archived_at?: number | null
  git_sha?: string | null
  git_branch?: string | null
  git_origin_url?: string | null
  cli_version?: string
  first_user_message?: string
  agent_nickname?: string | null
  agent_role?: string | null
  memory_mode?: string
  model?: string | null
  reasoning_effort?: string | null
  agent_path?: string | null
  created_at_ms?: number | null
  updated_at_ms?: number | null
  thread_source?: string | null
  preview?: string
  recency_at?: number
  recency_at_ms?: number
}

interface SourceThread {
  row: ThreadRow
  dbPath: string
  dbSource: "sqlite-dir" | "legacy-root"
}

interface ThreadToolRow {
  thread_id: string
  position: number
  name: string
  description: string
  input_schema: string
  defer_loading: number
  namespace: string | null
}

interface ThreadSpawnEdgeRow {
  parent_thread_id: string
  child_thread_id: string
  status: string
}

interface SessionIndexTitle {
  title: string
  updatedAtMs: number
}

const THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "created_at",
  "updated_at",
  "source",
  "model_provider",
  "cwd",
  "title",
  "sandbox_policy",
  "approval_mode",
  "tokens_used",
  "has_user_event",
  "archived",
  "archived_at",
  "git_sha",
  "git_branch",
  "git_origin_url",
  "cli_version",
  "first_user_message",
  "agent_nickname",
  "agent_role",
  "memory_mode",
  "model",
  "reasoning_effort",
  "agent_path",
  "created_at_ms",
  "updated_at_ms",
  "thread_source",
  "preview",
  "recency_at",
  "recency_at_ms",
] as const

const THREAD_TOOL_COLUMNS = [
  "thread_id",
  "position",
  "name",
  "description",
  "input_schema",
  "defer_loading",
  "namespace",
] as const

const THREAD_SPAWN_EDGE_COLUMNS = [
  "parent_thread_id",
  "child_thread_id",
  "status",
] as const

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ")
}

function comparableTime(row: ThreadRow) {
  return (
    Number(row.updated_at_ms) ||
    Number(row.recency_at_ms) ||
    Number(row.updated_at) * 1000 ||
    Number(row.created_at_ms) ||
    Number(row.created_at) * 1000 ||
    0
  )
}

function toNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function asString(value: unknown) {
  return typeof value === "string" ? value : ""
}

function mapSessionItem(
  source: SourceThread,
  duplicateSourceCount: number,
  sessionIndexTitles: Map<string, SessionIndexTitle>,
): CodexSessionItem {
  const row = source.row
  const indexedTitle = sessionIndexTitles.get(row.id)?.title.trim()
  return {
    id: row.id,
    title: indexedTitle || asString(row.title).trim() || row.id,
    preview: asString(row.preview) || asString(row.first_user_message),
    cwd: asString(row.cwd),
    modelProvider: asString(row.model_provider),
    model: asString(row.model),
    reasoningEffort: asString(row.reasoning_effort),
    archived: Boolean(row.archived),
    hasUserEvent: Boolean(row.has_user_event),
    tokensUsed: toNumber(row.tokens_used),
    createdAtMs: toNumber(row.created_at_ms) || toNumber(row.created_at) * 1000,
    updatedAtMs: comparableTime(row),
    recencyAtMs: toNumber(row.recency_at_ms) || toNumber(row.recency_at) * 1000,
    rolloutPath: asString(row.rollout_path),
    sourceDbPath: source.dbPath,
    sourceDbSource: source.dbSource,
    duplicateSourceCount,
  }
}

async function readSessionIndexTitles(home: string) {
  const path = join(home, "session_index.jsonl")
  const titles = new Map<string, SessionIndexTitle>()
  if (!(await fileExists(path))) return titles

  const content = await readFile(path, "utf8")
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const record = parsed as { id?: unknown; thread_name?: unknown; updated_at?: unknown }
    const id = typeof record.id === "string" ? record.id.trim() : ""
    const title = typeof record.thread_name === "string" ? record.thread_name.trim() : ""
    if (!id || !title) continue

    const updatedAtMs =
      typeof record.updated_at === "string" ? Date.parse(record.updated_at) || 0 : 0
    const current = titles.get(id)
    if (!current || updatedAtMs >= current.updatedAtMs) {
      titles.set(id, { title, updatedAtMs })
    }
  }
  return titles
}

function tableExists(db: SqliteDatabase, table: string) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined
  return Boolean(row?.name)
}

function tableColumns(db: SqliteDatabase, table: string) {
  return new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name: string }[]).map(
      (column) => column.name,
    ),
  )
}

function hasAllColumns(db: SqliteDatabase, table: string, columns: readonly string[]) {
  if (!tableExists(db, table)) return false
  const existing = tableColumns(db, table)
  return columns.every((column) => existing.has(column))
}

function readThreads(dbPath: string, dbSource: "sqlite-dir" | "legacy-root") {
  const db = openDatabase(dbPath, { readOnly: true })
  return db.then((database) => {
    try {
      if (!hasAllColumns(database, "threads", THREAD_COLUMNS)) return []
      return (database
        .prepare(`SELECT ${THREAD_COLUMNS.map(quoteIdentifier).join(", ")} FROM threads`)
        .all() as ThreadRow[])
        .filter((row) => typeof row.id === "string" && row.id.trim())
        .map((row) => ({ row, dbPath, dbSource }))
    } finally {
      database.close()
    }
  })
}

async function readToolsByThread(dbPath: string) {
  const db = await openDatabase(dbPath, { readOnly: true })
  try {
    if (!hasAllColumns(db, "thread_dynamic_tools", THREAD_TOOL_COLUMNS)) {
      return new Map<string, ThreadToolRow[]>()
    }
    const rows = db
      .prepare(
        `SELECT ${THREAD_TOOL_COLUMNS.map(quoteIdentifier).join(", ")} FROM thread_dynamic_tools`,
      )
      .all() as ThreadToolRow[]
    const byThread = new Map<string, ThreadToolRow[]>()
    for (const row of rows) {
      const list = byThread.get(row.thread_id) || []
      list.push(row)
      byThread.set(row.thread_id, list)
    }
    return byThread
  } finally {
    db.close()
  }
}

async function readSpawnEdges(dbPath: string) {
  const db = await openDatabase(dbPath, { readOnly: true })
  try {
    if (!hasAllColumns(db, "thread_spawn_edges", THREAD_SPAWN_EDGE_COLUMNS)) {
      return [] as ThreadSpawnEdgeRow[]
    }
    return db
      .prepare(
        `SELECT ${THREAD_SPAWN_EDGE_COLUMNS.map(quoteIdentifier).join(", ")} FROM thread_spawn_edges`,
      )
      .all() as ThreadSpawnEdgeRow[]
  } finally {
    db.close()
  }
}

export async function listDatabaseStatuses(home: string) {
  const statuses: CodexSessionDatabaseStatus[] = []
  for (const candidate of stateDbCandidates(home)) {
    const exists = await fileExists(candidate.path)
    let threadCount = 0
    let updatedAtMs = 0
    if (exists) {
      const db = await openDatabase(candidate.path, { readOnly: true })
      try {
        if (tableExists(db, "threads")) {
          const countRow = db.prepare("SELECT COUNT(*) AS count FROM threads").get() as {
            count?: number
          }
          const timeRow = db
            .prepare(
              "SELECT MAX(COALESCE(updated_at_ms, recency_at_ms, updated_at * 1000, created_at_ms, created_at * 1000, 0)) AS updated_at_ms FROM threads",
            )
            .get() as { updated_at_ms?: number }
          threadCount = Number(countRow?.count) || 0
          updatedAtMs = Number(timeRow?.updated_at_ms) || 0
        }
      } finally {
        db.close()
      }
    }
    statuses.push({ ...candidate, exists, threadCount, updatedAtMs })
  }
  return statuses
}

export async function collectLatestThreads(home: string) {
  const sources: SourceThread[] = []
  const sessionIndexTitles = await readSessionIndexTitles(home)
  for (const candidate of stateDbCandidates(home)) {
    if (!(await fileExists(candidate.path))) continue
    sources.push(...(await readThreads(candidate.path, candidate.source)))
  }

  const groups = new Map<string, SourceThread[]>()
  for (const source of sources) {
    const list = groups.get(source.row.id) || []
    list.push(source)
    groups.set(source.row.id, list)
  }

  const latest: SourceThread[] = []
  for (const list of groups.values()) {
    list.sort((left, right) => {
      const timeDelta = comparableTime(right.row) - comparableTime(left.row)
      if (timeDelta !== 0) return timeDelta
      const sourceDelta =
        (left.dbSource === "sqlite-dir" ? 0 : 1) - (right.dbSource === "sqlite-dir" ? 0 : 1)
      if (sourceDelta !== 0) return sourceDelta
      return right.dbPath.localeCompare(left.dbPath)
    })
    latest.push(list[0])
  }

  latest.sort((left, right) => comparableTime(right.row) - comparableTime(left.row))
  return {
    sources,
    latest,
    sessions: latest.map((source) =>
      mapSessionItem(source, groups.get(source.row.id)?.length || 1, sessionIndexTitles),
    ),
  }
}

export async function createDatabaseBackup(home: string, reason: string) {
  const root = backupRoot(home)
  const backupDir = join(
    root,
    `${new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replace(".", "")}-${reason}`,
  )
  const dbDir = join(backupDir, "db")
  await mkdir(dbDir, { recursive: true })
  const copied: string[] = []
  for (const candidate of stateDbCandidates(home)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      const source = `${candidate.path}${suffix}`
      if (!(await fileExists(source))) continue
      const rel = relative(home, source)
      const target = join(dbDir, rel && !rel.startsWith("..") ? rel : basename(source))
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      copied.push(rel || basename(source))
    }
  }
  return { backupDir, copied }
}

export async function mergeLatestThreadsIntoCanonical(home: string, provider: string) {
  const canonical = await detectCanonicalStateDb(home)
  if (!canonical) {
    return { mergedThreads: 0, deletedDuplicateThreads: 0, canonicalDbPath: "" }
  }

  const { latest } = await collectLatestThreads(home)
  const sourceTools = new Map<string, Map<string, ThreadToolRow[]>>()
  const sourceEdges = new Map<string, ThreadSpawnEdgeRow[]>()
  for (const source of latest) {
    if (!sourceTools.has(source.dbPath)) {
      sourceTools.set(source.dbPath, await readToolsByThread(source.dbPath))
      sourceEdges.set(source.dbPath, await readSpawnEdges(source.dbPath))
    }
  }

  const canonicalDb = await openDatabase(canonical.path)
  try {
    const existingIds = new Set(
      (canonicalDb.prepare("SELECT id FROM threads").all() as { id: string }[]).map(
        (row) => row.id,
      ),
    )
    const insertThread = canonicalDb.prepare(
      `INSERT INTO threads (${THREAD_COLUMNS.map(quoteIdentifier).join(", ")}) VALUES (${placeholders(THREAD_COLUMNS.length)})`,
    )
    const updateThread = canonicalDb.prepare(
      `UPDATE threads SET ${THREAD_COLUMNS.filter((column) => column !== "id")
        .map((column) => `${quoteIdentifier(column)} = ?`)
        .join(", ")} WHERE id = ?`,
    )
    const deleteThread = canonicalDb.prepare("DELETE FROM threads WHERE id = ?")
    const deleteTools = tableExists(canonicalDb, "thread_dynamic_tools")
      ? canonicalDb.prepare("DELETE FROM thread_dynamic_tools WHERE thread_id = ?")
      : null
    const insertTool =
      deleteTools && hasAllColumns(canonicalDb, "thread_dynamic_tools", THREAD_TOOL_COLUMNS)
        ? canonicalDb.prepare(
            `INSERT INTO thread_dynamic_tools (${THREAD_TOOL_COLUMNS.map(quoteIdentifier).join(", ")}) VALUES (${placeholders(THREAD_TOOL_COLUMNS.length)})`,
          )
        : null
    const deleteEdges = tableExists(canonicalDb, "thread_spawn_edges")
      ? canonicalDb.prepare(
          "DELETE FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?",
        )
      : null
    const insertEdge =
      deleteEdges && hasAllColumns(canonicalDb, "thread_spawn_edges", THREAD_SPAWN_EDGE_COLUMNS)
        ? canonicalDb.prepare(
            `INSERT OR IGNORE INTO thread_spawn_edges (${THREAD_SPAWN_EDGE_COLUMNS.map(quoteIdentifier).join(", ")}) VALUES (${placeholders(THREAD_SPAWN_EDGE_COLUMNS.length)})`,
          )
        : null

    canonicalDb.exec("PRAGMA busy_timeout = 5000")
    canonicalDb.exec("BEGIN IMMEDIATE")
    let mergedThreads = 0
    let deletedDuplicateThreads = 0
    try {
      for (const source of latest) {
        const row = { ...source.row, model_provider: provider }
        if (existingIds.has(row.id)) {
          updateThread.run(
            ...THREAD_COLUMNS.filter((column) => column !== "id").map((column) => row[column]),
            row.id,
          )
        } else {
          insertThread.run(...THREAD_COLUMNS.map((column) => row[column]))
          existingIds.add(row.id)
          mergedThreads += 1
        }

        deleteTools?.run(row.id)
        const tools = sourceTools.get(source.dbPath)?.get(row.id) || []
        for (const tool of tools) {
          insertTool?.run(...THREAD_TOOL_COLUMNS.map((column) => tool[column]))
        }

        deleteEdges?.run(row.id, row.id)
      }

      const latestIds = new Set(latest.map((source) => source.row.id))
      for (const existingId of existingIds) {
        if (latestIds.has(existingId)) continue
        deletedDuplicateThreads += deleteThread.run(existingId).changes || 0
        deleteTools?.run(existingId)
        deleteEdges?.run(existingId, existingId)
      }

      const canonicalIds = new Set(latest.map((source) => source.row.id))
      const insertedEdges = new Set<string>()
      for (const source of latest) {
        const edges = sourceEdges.get(source.dbPath) || []
        for (const edge of edges) {
          if (
            !canonicalIds.has(edge.parent_thread_id) ||
            !canonicalIds.has(edge.child_thread_id)
          ) {
            continue
          }
          const key = `${edge.parent_thread_id}:${edge.child_thread_id}`
          if (insertedEdges.has(key)) continue
          insertedEdges.add(key)
          insertEdge?.run(...THREAD_SPAWN_EDGE_COLUMNS.map((column) => edge[column]))
        }
      }

      canonicalDb.exec("COMMIT")
      return { mergedThreads, deletedDuplicateThreads, canonicalDbPath: canonical.path }
    } catch (error) {
      canonicalDb.exec("ROLLBACK")
      throw error
    }
  } finally {
    canonicalDb.close()
  }
}

export async function deleteThreadsFromDatabases(home: string, threadIds: string[]) {
  const ids = Array.from(new Set(threadIds.map((id) => id.trim()).filter(Boolean)))
  let deletedSqliteRows = 0
  let deletedSessionIndexRows = 0
  if (ids.length === 0) return { deletedSqliteRows, deletedSessionIndexRows }

  for (const candidate of stateDbCandidates(home)) {
    if (!(await fileExists(candidate.path))) continue
    const db = await openDatabase(candidate.path)
    try {
      db.exec("PRAGMA busy_timeout = 5000")
      db.exec("BEGIN IMMEDIATE")
      try {
        if (tableExists(db, "thread_dynamic_tools")) {
          const deleteTools = db.prepare("DELETE FROM thread_dynamic_tools WHERE thread_id = ?")
          for (const id of ids) deletedSqliteRows += deleteTools.run(id).changes || 0
        }
        if (tableExists(db, "thread_spawn_edges")) {
          const deleteEdges = db.prepare(
            "DELETE FROM thread_spawn_edges WHERE parent_thread_id = ? OR child_thread_id = ?",
          )
          for (const id of ids) deletedSqliteRows += deleteEdges.run(id, id).changes || 0
        }
        if (tableExists(db, "threads")) {
          const deleteThread = db.prepare("DELETE FROM threads WHERE id = ?")
          for (const id of ids) deletedSqliteRows += deleteThread.run(id).changes || 0
        }
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    } finally {
      db.close()
    }
  }

  for (const candidate of stateDbCandidates(home)) {
    const sessionIndexPath = join(dirname(candidate.path), "session_index.jsonl")
    deletedSessionIndexRows += await removeSessionIndexRows(sessionIndexPath, ids)
  }

  return { deletedSqliteRows, deletedSessionIndexRows }
}

async function removeSessionIndexRows(path: string, threadIds: string[]) {
  if (!(await fileExists(path))) return 0
  const removeIds = new Set(threadIds)
  const content = await readFile(path, "utf8")
  const retained: string[] = []
  let removed = 0
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        removeIds.has(String((parsed as { id?: unknown }).id || ""))
      ) {
        removed += 1
        continue
      }
    } catch {
      // Preserve malformed lines instead of corrupting an index we cannot parse.
    }
    retained.push(line)
  }
  if (removed === 0) return 0
  await writeFile(path, retained.length > 0 ? `${retained.join("\n")}\n` : "", "utf8")
  return removed
}

export async function databaseFileSize(path: string) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
