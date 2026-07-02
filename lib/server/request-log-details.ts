import "server-only"

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { RequestLog, RequestLogDetail } from "@/lib/types"

interface RequestLogDetailSource {
  enabled?: boolean
  rawBody?: unknown
  rewrittenBody?: unknown
}

const detailSources = new WeakMap<RequestLog, RequestLogDetailSource>()

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
