import "server-only"

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { compactTokenStats } from "@/lib/server/token-stat-retention"
import { pruneRequestLogDetails } from "@/lib/server/request-log-details"
import { tokenStatFromLog } from "@/lib/token-stats"
import { resolveDataDir } from "@/lib/server/data-root"
import type {
  ChatStreamTruth,
  RequestLog,
  Settings,
  TokenStatAggregation,
  TokenStatEntry,
} from "@/lib/types"

const MAX_LOGS = 500
const RECENT_LOG_CACHE = 100
const RECENT_TOKEN_STATS_CACHE = 200
const MAX_STORED_LOG_FIELD_CHARS = 4000
const MAX_LIST_LOG_FIELD_CHARS = 800
const COMPACT_EVERY_WRITES = 50

/**
 * 遥测缓存与写队列按数据目录分桶，避免多个账号互相看到对方的日志与 Token 统计。
 */
interface TelemetryBucket {
  queue: Promise<unknown>
  logs: RequestLog[] | null
  tokenStats: TokenStatEntry[] | null
  writesSinceCompact: number
}

const buckets = new Map<string, TelemetryBucket>()

function bucketFor(dataDir = resolveDataDir()): TelemetryBucket {
  let bucket = buckets.get(dataDir)
  if (!bucket) {
    bucket = { queue: Promise.resolve(), logs: null, tokenStats: null, writesSinceCompact: 0 }
    buckets.set(dataDir, bucket)
  }
  return bucket
}

function telemetryRoot(dataDir = resolveDataDir()) {
  return join(dataDir, "telemetry")
}

function requestLogsPath(dataDir = resolveDataDir()) {
  return join(telemetryRoot(dataDir), "request-logs.jsonl")
}

function tokenStatsPath(dataDir = resolveDataDir()) {
  return join(telemetryRoot(dataDir), "token-stats.jsonl")
}

async function ensureTelemetryDir(dataDir = resolveDataDir()) {
  await mkdir(telemetryRoot(dataDir), { recursive: true })
}

function enqueueTelemetry<T>(task: () => Promise<T>, dataDir = resolveDataDir()): Promise<T> {
  const bucket = bucketFor(dataDir)
  const run = bucket.queue.catch(() => undefined).then(task)
  bucket.queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
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
    cacheMeasuredCachedInputTokens:
      Number(entry.cacheMeasuredCachedInputTokens) || 0,
    cacheMeasuredInputTokens: Number(entry.cacheMeasuredInputTokens) || 0,
    cacheMeasuredRequests: Number(entry.cacheMeasuredRequests) || 0,
    reasoningTokens: Number(entry.reasoningTokens) || 0,
    requestCount:
      Number.isFinite(entry.requestCount) && Number(entry.requestCount) >= 1
        ? Math.round(Number(entry.requestCount))
        : 1,
    aggregation:
      entry.aggregation === "day" || entry.aggregation === "history"
        ? (entry.aggregation as TokenStatAggregation)
        : "request",
    ...(typeof entry.resetAt === "string" && entry.resetAt.trim()
      ? { resetAt: entry.resetAt }
      : {}),
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

function normalizeChatStreamTruth(
  value: unknown,
): Pick<RequestLog, "chatStreamTruth"> {
  if (!isObject(value)) return {}
  const truth = value as Partial<ChatStreamTruth>
  return {
    chatStreamTruth: {
      upstreamFinishReason: safeString(truth.upstreamFinishReason),
      finalFinishReason: safeString(truth.finalFinishReason),
      finishReasonSource:
        truth.finishReasonSource === "upstream" ||
        truth.finishReasonSource === "synthesized"
          ? truth.finishReasonSource
          : "none",
      sawChoice: truth.sawChoice === true,
      sawDoneFrame: truth.sawDoneFrame === true,
      toolCallCount:
        Number.isFinite(truth.toolCallCount) && Number(truth.toolCallCount) >= 0
          ? Number(truth.toolCallCount)
          : 0,
      lastInputItemType: safeString(truth.lastInputItemType),
      visibleChars:
        Number.isFinite(truth.visibleChars) && Number(truth.visibleChars) >= 0
          ? Number(truth.visibleChars)
          : 0,
      reasoningChars:
        Number.isFinite(truth.reasoningChars) && Number(truth.reasoningChars) >= 0
          ? Number(truth.reasoningChars)
          : 0,
      settledAs:
        truth.settledAs === "incomplete" ||
        truth.settledAs === "failed" ||
        truth.settledAs === "aborted"
          ? truth.settledAs
          : "completed",
    },
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
    ...(log.chatStreamTruth ? normalizeChatStreamTruth(log.chatStreamTruth) : {}),
    id: log.id,
    timestamp: log.timestamp,
    codexModel: log.codexModel,
    finalProviderId: log.finalProviderId,
    finalModelId: log.finalModelId,
    finalEndpointId: log.finalEndpointId,
    finalEndpointName: log.finalEndpointName,
    attemptedEndpointIds: Array.isArray(log.attemptedEndpointIds)
      ? log.attemptedEndpointIds.filter((id): id is string => typeof id === "string")
      : undefined,
    failoverReason: log.failoverReason,
    reasoning: log.reasoning as RequestLog["reasoning"],
    statusCode: Number(log.statusCode),
    durationMs: Number(log.durationMs),
    ...(typeof log.stream === "boolean" ? { stream: log.stream } : {}),
    ...(Number.isFinite(log.firstTokenMs) && Number(log.firstTokenMs) >= 0
      ? { firstTokenMs: Number(log.firstTokenMs) }
      : {}),
    ...(Number.isFinite(log.outputTokensPerSecond) &&
    Number(log.outputTokensPerSecond) >= 0
      ? { outputTokensPerSecond: Number(log.outputTokensPerSecond) }
      : {}),
    tokenUsage: log.tokenUsage,
    ...(typeof log.workbuddyUid === "string" && log.workbuddyUid.trim()
      ? { workbuddyUid: log.workbuddyUid.trim() }
      : {}),
    ...(log.workbuddyRealm === "cn" || log.workbuddyRealm === "global"
      ? { workbuddyRealm: log.workbuddyRealm }
      : {}),
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

async function writeJsonlAtomic(path: string, items: unknown[]) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const text = items.length
    ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
    : ""
  await writeFile(tempPath, text, "utf8")
  await rename(tempPath, path)
}

async function readStoredLogs(dataDir = resolveDataDir()) {
  return readJsonl(requestLogsPath(dataDir), normalizeLogValue)
}

async function readStoredTokenStats(dataDir = resolveDataDir()) {
  return readJsonl(tokenStatsPath(dataDir), normalizeTokenStat)
}

async function compactTelemetryFiles(settings: Settings, dataDir = resolveDataDir()) {
  const bucket = bucketFor(dataDir)
  const logs = pruneLogs(await readStoredLogs(dataDir), settings)
  const tokenStats = compactTokenStats(await readStoredTokenStats(dataDir))
  await Promise.all([
    writeJsonlAtomic(requestLogsPath(dataDir), [...logs].reverse()),
    writeJsonlAtomic(tokenStatsPath(dataDir), [...tokenStats].reverse()),
  ])
  bucket.logs = logs.slice(0, RECENT_LOG_CACHE).map(toListLog)
  bucket.tokenStats = tokenStats.slice(0, RECENT_TOKEN_STATS_CACHE)

  // 全量请求日志的明细目录不归 jsonl 管，必须跟 pruneLogs 用同一份保留集合
  // 一起清；先落盘日志再清目录，崩溃时最坏留一批孤儿目录，不会出现“日志还在、
  // 明细没了”。
  await pruneRequestLogDetails({
    keepIds: new Set(logs.map((log) => log.id)),
  })
}

export async function appendTelemetryLog(log: RequestLog, settings: Settings) {
  const dataDir = resolveDataDir()
  const bucket = bucketFor(dataDir)
  return enqueueTelemetry(async () => {
    await ensureTelemetryDir(dataDir)
    const storedLog = normalizeStoredLog(log)
    await appendFile(requestLogsPath(dataDir), `${JSON.stringify(storedLog)}\n`, "utf8")
    const tokenStat = tokenStatFromLog(storedLog, settings.tokenStatsResetAt)
    if (tokenStat) {
      await appendFile(tokenStatsPath(dataDir), `${JSON.stringify(tokenStat)}\n`, "utf8")
    }

    bucket.logs = [toListLog(storedLog), ...(bucket.logs ?? [])].slice(0, RECENT_LOG_CACHE)
    if (tokenStat) {
      bucket.tokenStats = [tokenStat, ...(bucket.tokenStats ?? [])].slice(
        0,
        RECENT_TOKEN_STATS_CACHE,
      )
    }

    bucket.writesSinceCompact += 1
    if (bucket.writesSinceCompact >= COMPACT_EVERY_WRITES) {
      bucket.writesSinceCompact = 0
      await compactTelemetryFiles(settings, dataDir)
    }
  }, dataDir)
}

export async function getRequestLogs(settings: Settings) {
  const dataDir = resolveDataDir()
  const bucket = bucketFor(dataDir)
  await bucket.queue.catch(() => undefined)
  const logs = pruneLogs(await readStoredLogs(dataDir), settings).map(toListLog)
  bucket.logs = logs.slice(0, RECENT_LOG_CACHE)
  return logs
}

export async function getAllRequestLogs(settings: Settings) {
  const dataDir = resolveDataDir()
  await bucketFor(dataDir).queue.catch(() => undefined)
  return pruneLogs(await readStoredLogs(dataDir), settings)
}

export async function findRequestLog(id: string) {
  const dataDir = resolveDataDir()
  await bucketFor(dataDir).queue.catch(() => undefined)
  return (await readStoredLogs(dataDir)).find((log) => log.id === id) ?? null
}

export async function getTokenStats() {
  const dataDir = resolveDataDir()
  const bucket = bucketFor(dataDir)
  await bucket.queue.catch(() => undefined)
  const tokenStats = compactTokenStats(await readStoredTokenStats(dataDir))
  bucket.tokenStats = tokenStats.slice(0, RECENT_TOKEN_STATS_CACHE)
  return tokenStats
}

export async function getAllTokenStats() {
  const dataDir = resolveDataDir()
  await bucketFor(dataDir).queue.catch(() => undefined)
  return compactTokenStats(await readStoredTokenStats(dataDir))
}

export async function importLegacyTelemetry(
  value: {
    logs?: unknown
    tokenStats?: unknown
  },
  settings: Settings,
) {
  const dataDir = resolveDataDir()
  const bucket = bucketFor(dataDir)
  const legacyLogs = Array.isArray(value.logs)
    ? value.logs.map(normalizeLogValue).filter((log): log is RequestLog => Boolean(log))
    : []
  const legacyTokenStats = Array.isArray(value.tokenStats)
    ? value.tokenStats
        .map(normalizeTokenStat)
        .filter((entry): entry is TokenStatEntry => Boolean(entry))
    : legacyLogs
        .map((log) => tokenStatFromLog(log))
        .filter((entry): entry is TokenStatEntry => Boolean(entry))

  if (legacyLogs.length === 0 && legacyTokenStats.length === 0) return

  await enqueueTelemetry(async () => {
    await ensureTelemetryDir(dataDir)
    const logById = new Map<string, RequestLog>()
    for (const log of await readStoredLogs(dataDir)) logById.set(log.id, log)
    for (const log of legacyLogs) logById.set(log.id, log)

    const tokenStatById = new Map<string, TokenStatEntry>()
    for (const entry of await readStoredTokenStats(dataDir)) tokenStatById.set(entry.id, entry)
    for (const entry of legacyTokenStats) tokenStatById.set(entry.id, entry)

    const logs = pruneLogs([...logById.values()], settings)
    const tokenStats = compactTokenStats([...tokenStatById.values()])
    await Promise.all([
      writeJsonlAtomic(requestLogsPath(dataDir), [...logs].reverse()),
      writeJsonlAtomic(tokenStatsPath(dataDir), [...tokenStats].reverse()),
    ])
    bucket.logs = logs.slice(0, RECENT_LOG_CACHE).map(toListLog)
    bucket.tokenStats = tokenStats.slice(0, RECENT_TOKEN_STATS_CACHE)
  }, dataDir)
}

export async function compactTelemetry(settings: Settings) {
  const dataDir = resolveDataDir()
  await enqueueTelemetry(async () => compactTelemetryFiles(settings, dataDir), dataDir)
}

export function telemetryFilePaths() {
  const dataDir = resolveDataDir()
  return {
    requestLogs: requestLogsPath(dataDir),
    tokenStats: tokenStatsPath(dataDir),
  }
}
