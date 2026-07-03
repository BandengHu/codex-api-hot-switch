import "server-only"

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { tokenStatFromLog } from "@/lib/token-stats"
import type { RequestLog, Settings, TokenStatEntry } from "@/lib/types"

const MAX_LOGS = 500
const MAX_TOKEN_STATS = 2000
const RECENT_LOG_CACHE = 100
const RECENT_TOKEN_STATS_CACHE = 200
const MAX_STORED_LOG_FIELD_CHARS = 4000
const MAX_LIST_LOG_FIELD_CHARS = 800
const COMPACT_EVERY_WRITES = 50

let telemetryQueue: Promise<unknown> = Promise.resolve()
let recentLogsCache: RequestLog[] | null = null
let recentTokenStatsCache: TokenStatEntry[] | null = null
let writesSinceCompact = 0

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

function telemetryRoot() {
  return join(process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir(), "telemetry")
}

function requestLogsPath() {
  return join(telemetryRoot(), "request-logs.jsonl")
}

function tokenStatsPath() {
  return join(telemetryRoot(), "token-stats.jsonl")
}

async function ensureTelemetryDir() {
  await mkdir(telemetryRoot(), { recursive: true })
}

function enqueueTelemetry<T>(task: () => Promise<T>): Promise<T> {
  const run = telemetryQueue.catch(() => undefined).then(task)
  telemetryQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function truncateField(value: unknown, maxChars: number) {
  const text = typeof value === "string" ? value : String(value ?? "")
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}... [stored log field truncated]`
    : text
}

function normalizeStoredLog(log: RequestLog): RequestLog {
  return {
    ...log,
    rawRequest: truncateField(log.rawRequest, MAX_STORED_LOG_FIELD_CHARS),
    rewrittenRequest: truncateField(log.rewrittenRequest, MAX_STORED_LOG_FIELD_CHARS),
    responseSummary: truncateField(log.responseSummary, MAX_STORED_LOG_FIELD_CHARS),
    ...(log.errorStack
      ? { errorStack: truncateField(log.errorStack, MAX_STORED_LOG_FIELD_CHARS) }
      : {}),
  }
}

function toListLog(log: RequestLog): RequestLog {
  return {
    ...log,
    rawRequest: "",
    rewrittenRequest: "",
    responseSummary: truncateField(log.responseSummary, MAX_LIST_LOG_FIELD_CHARS),
    ...(log.errorStack
      ? { errorStack: truncateField(log.errorStack, MAX_LIST_LOG_FIELD_CHARS) }
      : {}),
  }
}

function normalizeTokenStat(value: unknown): TokenStatEntry | null {
  if (!value || typeof value !== "object") return null
  const entry = value as Partial<TokenStatEntry>
  if (
    typeof entry.id !== "string" ||
    typeof entry.timestamp !== "string" ||
    typeof entry.providerId !== "string" ||
    typeof entry.modelId !== "string" ||
    typeof entry.codexModel !== "string" ||
    !Number.isFinite(entry.statusCode) ||
    !Number.isFinite(entry.inputTokens) ||
    !Number.isFinite(entry.outputTokens) ||
    !Number.isFinite(entry.totalTokens)
  ) {
    return null
  }
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    providerId: entry.providerId,
    modelId: entry.modelId,
    codexModel: entry.codexModel,
    statusCode: Number(entry.statusCode),
    inputTokens: Number(entry.inputTokens),
    outputTokens: Number(entry.outputTokens),
    totalTokens: Number(entry.totalTokens),
    cachedInputTokens: Number(entry.cachedInputTokens) || 0,
    cacheCreationInputTokens: Number(entry.cacheCreationInputTokens) || 0,
    reasoningTokens: Number(entry.reasoningTokens) || 0,
  }
}

async function readJsonl<T>(path: string, normalize: (value: unknown) => T | null): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8")
    const items: T[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const item = normalize(JSON.parse(line))
        if (item) items.push(item)
      } catch {
        // Ignore a single corrupt line instead of losing the whole telemetry file.
      }
    }
    return items
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

function normalizeLogValue(value: unknown): RequestLog | null {
  if (!value || typeof value !== "object") return null
  const log = value as Partial<RequestLog>
  if (
    typeof log.id !== "string" ||
    typeof log.timestamp !== "string" ||
    typeof log.codexModel !== "string" ||
    typeof log.finalProviderId !== "string" ||
    typeof log.finalModelId !== "string" ||
    typeof log.reasoning !== "string" ||
    !Number.isFinite(log.statusCode) ||
    !Number.isFinite(log.durationMs)
  ) {
    return null
  }
  return normalizeStoredLog({
    id: log.id,
    timestamp: log.timestamp,
    codexModel: log.codexModel,
    finalProviderId: log.finalProviderId,
    finalModelId: log.finalModelId,
    reasoning: log.reasoning as RequestLog["reasoning"],
    statusCode: Number(log.statusCode),
    durationMs: Number(log.durationMs),
    tokenUsage: log.tokenUsage,
    error: log.error,
    rawRequest: log.rawRequest ?? "",
    rewrittenRequest: log.rewrittenRequest ?? "",
    responseSummary: log.responseSummary ?? "",
    errorStack: log.errorStack,
  })
}

function descendingByTimestamp<T extends { timestamp: string }>(items: T[]) {
  return [...items].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
}

function pruneLogs(logs: RequestLog[], settings: Settings) {
  const retentionDays = Math.max(1, Number(settings.logRetentionDays) || 1)
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  return descendingByTimestamp(logs)
    .filter((log) => {
      const timestamp = Date.parse(log.timestamp)
      return !Number.isFinite(timestamp) || timestamp >= cutoff
    })
    .slice(0, MAX_LOGS)
}

function pruneTokenStats(tokenStats: TokenStatEntry[]) {
  return descendingByTimestamp(tokenStats).slice(0, MAX_TOKEN_STATS)
}

async function writeJsonlAtomic(path: string, items: unknown[]) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const text = items.length
    ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
    : ""
  await writeFile(tempPath, text, "utf8")
  await rename(tempPath, path)
}

async function readStoredLogs() {
  return readJsonl(requestLogsPath(), normalizeLogValue)
}

async function readStoredTokenStats() {
  return readJsonl(tokenStatsPath(), normalizeTokenStat)
}

async function compactTelemetryFiles(settings: Settings) {
  const logs = pruneLogs(await readStoredLogs(), settings)
  const tokenStats = pruneTokenStats(await readStoredTokenStats())
  await Promise.all([
    writeJsonlAtomic(requestLogsPath(), [...logs].reverse()),
    writeJsonlAtomic(tokenStatsPath(), [...tokenStats].reverse()),
  ])
  recentLogsCache = logs.slice(0, RECENT_LOG_CACHE).map(toListLog)
  recentTokenStatsCache = tokenStats.slice(0, RECENT_TOKEN_STATS_CACHE)
}

export async function appendTelemetryLog(log: RequestLog, settings: Settings) {
  return enqueueTelemetry(async () => {
    await ensureTelemetryDir()
    const storedLog = normalizeStoredLog(log)
    await appendFile(requestLogsPath(), `${JSON.stringify(storedLog)}\n`, "utf8")
    const tokenStat = tokenStatFromLog(storedLog)
    if (tokenStat) {
      await appendFile(tokenStatsPath(), `${JSON.stringify(tokenStat)}\n`, "utf8")
    }

    recentLogsCache = [toListLog(storedLog), ...(recentLogsCache ?? [])].slice(0, RECENT_LOG_CACHE)
    if (tokenStat) {
      recentTokenStatsCache = [tokenStat, ...(recentTokenStatsCache ?? [])].slice(
        0,
        RECENT_TOKEN_STATS_CACHE,
      )
    }

    writesSinceCompact += 1
    if (writesSinceCompact >= COMPACT_EVERY_WRITES) {
      writesSinceCompact = 0
      await compactTelemetryFiles(settings)
    }
  })
}

export async function getRequestLogs(settings: Settings) {
  await telemetryQueue.catch(() => undefined)
  const logs = pruneLogs(await readStoredLogs(), settings).map(toListLog)
  recentLogsCache = logs.slice(0, RECENT_LOG_CACHE)
  return logs
}

export async function getAllRequestLogs(settings: Settings) {
  await telemetryQueue.catch(() => undefined)
  return pruneLogs(await readStoredLogs(), settings)
}

export async function findRequestLog(id: string) {
  await telemetryQueue.catch(() => undefined)
  return (await readStoredLogs()).find((log) => log.id === id) ?? null
}

export async function getTokenStats() {
  await telemetryQueue.catch(() => undefined)
  const tokenStats = pruneTokenStats(await readStoredTokenStats())
  recentTokenStatsCache = tokenStats.slice(0, RECENT_TOKEN_STATS_CACHE)
  return tokenStats
}

export async function getAllTokenStats() {
  await telemetryQueue.catch(() => undefined)
  return pruneTokenStats(await readStoredTokenStats())
}

export async function importLegacyTelemetry(
  value: {
    logs?: unknown
    tokenStats?: unknown
  },
  settings: Settings,
) {
  const legacyLogs = Array.isArray(value.logs)
    ? value.logs.map(normalizeLogValue).filter((log): log is RequestLog => Boolean(log))
    : []
  const legacyTokenStats = Array.isArray(value.tokenStats)
    ? value.tokenStats
        .map(normalizeTokenStat)
        .filter((entry): entry is TokenStatEntry => Boolean(entry))
    : legacyLogs
        .map(tokenStatFromLog)
        .filter((entry): entry is TokenStatEntry => Boolean(entry))

  if (legacyLogs.length === 0 && legacyTokenStats.length === 0) return

  await enqueueTelemetry(async () => {
    await ensureTelemetryDir()
    const logById = new Map<string, RequestLog>()
    for (const log of await readStoredLogs()) logById.set(log.id, log)
    for (const log of legacyLogs) logById.set(log.id, log)

    const tokenStatById = new Map<string, TokenStatEntry>()
    for (const entry of await readStoredTokenStats()) tokenStatById.set(entry.id, entry)
    for (const entry of legacyTokenStats) tokenStatById.set(entry.id, entry)

    const logs = pruneLogs([...logById.values()], settings)
    const tokenStats = pruneTokenStats([...tokenStatById.values()])
    await Promise.all([
      writeJsonlAtomic(requestLogsPath(), [...logs].reverse()),
      writeJsonlAtomic(tokenStatsPath(), [...tokenStats].reverse()),
    ])
    recentLogsCache = logs.slice(0, RECENT_LOG_CACHE).map(toListLog)
    recentTokenStatsCache = tokenStats.slice(0, RECENT_TOKEN_STATS_CACHE)
  })
}

export async function compactTelemetry(settings: Settings) {
  await enqueueTelemetry(async () => compactTelemetryFiles(settings))
}

export function telemetryFilePaths() {
  return {
    requestLogs: requestLogsPath(),
    tokenStats: tokenStatsPath(),
  }
}
