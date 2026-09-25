import "server-only"

import type { Dirent } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { RequestLog, RequestLogDetail } from "@/lib/types"

interface RequestLogDetailSource {
  enabled?: boolean
  rawBody?: unknown
  rewrittenBody?: unknown
}

const detailSources = new WeakMap<RequestLog, RequestLogDetailSource>()

// 目录名就是日志 id（见 pipeline 的 `log-${Date.now()}-${uuid}`），
// 所以能直接从名字取回创建时间，不用为每个目录做一次 stat。
const LOG_ID_TIMESTAMP_PATTERN = /^log-(\d+)-/

// appendRequestLogDetails 与 appendLog 是两个并行的 detached 任务，压缩可能
// 在"明细目录已建好、日志行还没落盘"的间隙跑起来；这段宽限期保证在途请求
// 的明细不会被当成过期数据删掉。
const PRUNE_GRACE_MS = 10 * 60 * 1000

// 一次要删几千个目录，串行 rm 会让压缩队列卡太久。
const PRUNE_CONCURRENCY = 8

function defaultDataDir() {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "codex-api-hot-switch",
      "data",
    )
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "codex-api-hot-switch", "data")
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "codex-api-hot-switch",
    "data",
  )
}

function requestDetailsRoot() {
  return join(
    process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir(),
    "logs",
    "request-details",
  )
}

function safeFileId(id: string) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_")
}

function detailDir(logId: string) {
  return join(requestDetailsRoot(), safeFileId(logId))
}

function fullJsonText(value: unknown) {
  if (typeof value === "string") return value
  if (value == null) return ""
  const seen = new WeakSet<object>()
  try {
    return `${JSON.stringify(
      value,
      (_key, child) => {
        if (child && typeof child === "object") {
          if (seen.has(child)) return "[Circular]"
          seen.add(child)
        }
        return child
      },
      2,
    )}\n`
  } catch (error) {
    return error instanceof Error ? `[Unserializable: ${error.message}]` : "[Unserializable]"
  }
}

async function readTextIfExists(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export function registerRequestLogDetailSource(
  log: RequestLog,
  source: RequestLogDetailSource,
) {
  detailSources.set(log, source)
}

export async function appendRequestLogDetails(log: RequestLog) {
  const source = detailSources.get(log)
  if (!source?.enabled) return
  const dir = detailDir(log.id)
  await mkdir(dir, { recursive: true })
  await Promise.all([
    writeFile(join(dir, "raw-request.json"), fullJsonText(source.rawBody), "utf8"),
    source.rewrittenBody == null
      ? Promise.resolve()
      : writeFile(join(dir, "rewritten-request.json"), fullJsonText(source.rewrittenBody), "utf8"),
  ])
}

export async function readRequestLogDetail(log: RequestLog): Promise<RequestLogDetail> {
  const dir = detailDir(log.id)
  const rawRequest = await readTextIfExists(join(dir, "raw-request.json"))
  const rewrittenRequest = await readTextIfExists(join(dir, "rewritten-request.json"))
  return {
    id: log.id,
    rawRequest: rawRequest ?? log.rawRequest,
    rewrittenRequest: rewrittenRequest ?? log.rewrittenRequest,
    responseSummary: log.responseSummary,
    hasFullRawRequest: rawRequest != null,
    hasFullRewrittenRequest: rewrittenRequest != null,
  }
}

export function requestLogDetailsRootPath() {
  return requestDetailsRoot()
}

export interface RequestLogDetailPruneResult {
  scanned: number
  removed: number
  kept: number
}

async function entryCreatedAtMs(entry: Dirent, path: string) {
  const match = LOG_ID_TIMESTAMP_PATTERN.exec(entry.name)
  if (match) {
    const value = Number(match[1])
    if (Number.isFinite(value) && value > 0) return value
  }
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

// 明细目录跟日志列表共用同一份保留口径：只留 pruneLogs 保住的那些日志 id。
// 没有这一步，全量请求日志会让 data/logs/request-details 无限增长。
export async function pruneRequestLogDetails(params: {
  keepIds: ReadonlySet<string>
  now?: number
  graceMs?: number
}): Promise<RequestLogDetailPruneResult> {
  const root = requestDetailsRoot()
  const now = params.now ?? Date.now()
  const graceMs = params.graceMs ?? PRUNE_GRACE_MS

  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: 0, removed: 0, kept: 0 }
    }
    throw error
  }

  const expired: string[] = []
  let kept = 0
  for (const entry of entries) {
    if (params.keepIds.has(entry.name)) {
      kept += 1
      continue
    }
    const path = join(root, entry.name)
    const createdAt = await entryCreatedAtMs(entry, path)
    if (createdAt != null && now - createdAt < graceMs) {
      kept += 1
      continue
    }
    expired.push(path)
  }

  let removed = 0
  for (let index = 0; index < expired.length; index += PRUNE_CONCURRENCY) {
    const batch = expired.slice(index, index + PRUNE_CONCURRENCY)
    const results = await Promise.all(
      batch.map(async (path): Promise<number> => {
        try {
          await rm(path, { recursive: true, force: true })
          return 1
        } catch {
          return 0
        }
      }),
    )
    removed += results.reduce((total, value) => total + value, 0)
  }

  return { scanned: entries.length, removed, kept }
}
