import type {
  TokenStatAggregation,
  TokenStatEntry,
} from "@/lib/types"
import { tokenStatRequestCount } from "@/lib/token-stats"

export const MAX_RECENT_TOKEN_STATS = 2000

const DAILY_ROLLUP_RETENTION_DAYS = 45

function timestampValue(timestamp: string) {
  const value = Date.parse(timestamp)
  return Number.isFinite(value) ? value : 0
}

function aggregationOf(entry: TokenStatEntry): TokenStatAggregation {
  return entry.aggregation === "day" || entry.aggregation === "history"
    ? entry.aggregation
    : "request"
}

function resetKey(entry: TokenStatEntry) {
  return entry.resetAt || "legacy"
}

function dimensionKey(entry: TokenStatEntry) {
  return JSON.stringify([
    resetKey(entry),
    entry.providerId,
    entry.modelId,
    entry.codexModel,
    entry.statusCode,
  ])
}

function localDayKey(timestamp: string) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return "unknown"
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
}

function localDayTimestamp(timestamp: string) {
  const date = new Date(timestamp)
  if (!Number.isFinite(date.getTime())) return timestamp
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).toISOString()
}

function rollupId(kind: "day" | "history", key: string) {
  return `token-rollup-${kind}-${encodeURIComponent(key)}`
}

function addEntry(
  current: TokenStatEntry | undefined,
  entry: TokenStatEntry,
  aggregation: "day" | "history",
  key: string,
) {
  if (!current) {
    return {
      ...entry,
      id: rollupId(aggregation, key),
      timestamp:
        aggregation === "day" ? localDayTimestamp(entry.timestamp) : entry.timestamp,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      cachedInputTokens: entry.cachedInputTokens,
      cacheCreationInputTokens: entry.cacheCreationInputTokens,
      cacheMeasuredCachedInputTokens: entry.cacheMeasuredCachedInputTokens,
      cacheMeasuredInputTokens: entry.cacheMeasuredInputTokens,
      cacheMeasuredRequests: entry.cacheMeasuredRequests,
      reasoningTokens: entry.reasoningTokens,
      requestCount: tokenStatRequestCount(entry),
      aggregation,
    }
  }

  current.inputTokens += entry.inputTokens
  current.outputTokens += entry.outputTokens
  current.totalTokens += entry.totalTokens
  current.cachedInputTokens += entry.cachedInputTokens
  current.cacheCreationInputTokens += entry.cacheCreationInputTokens
  current.cacheMeasuredCachedInputTokens += entry.cacheMeasuredCachedInputTokens
  current.cacheMeasuredInputTokens += entry.cacheMeasuredInputTokens
  current.cacheMeasuredRequests += entry.cacheMeasuredRequests
  current.reasoningTokens += entry.reasoningTokens
  current.requestCount = tokenStatRequestCount(current) + tokenStatRequestCount(entry)
  if (
    aggregation === "history" &&
    timestampValue(entry.timestamp) > timestampValue(current.timestamp)
  ) {
    current.timestamp = entry.timestamp
  }
  return current
}

function isRecentDay(timestamp: string, now: number) {
  const cutoff = now - DAILY_ROLLUP_RETENTION_DAYS * 24 * 60 * 60 * 1000
  return timestampValue(timestamp) >= cutoff
}

export function compactTokenStats(entries: TokenStatEntry[], now = Date.now()) {
  const rawEntries = entries
    .filter((entry) => aggregationOf(entry) === "request")
    .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp))
  const keptRaw = rawEntries.slice(0, MAX_RECENT_TOKEN_STATS)
  const overflow = rawEntries.slice(MAX_RECENT_TOKEN_STATS)
  const existingRollups = entries.filter((entry) => aggregationOf(entry) !== "request")
  const dayEntries = [
    ...existingRollups.filter((entry) => aggregationOf(entry) === "day"),
    ...overflow,
  ]
  const historyEntries = existingRollups.filter(
    (entry) => aggregationOf(entry) === "history",
  )
  const dayRollups = new Map<string, TokenStatEntry>()
  const historyRollups = new Map<string, TokenStatEntry>()

  for (const entry of dayEntries) {
    const day = localDayKey(entry.timestamp)
    const key = `${dimensionKey(entry)}|${day}`
    if (day !== "unknown" && isRecentDay(entry.timestamp, now)) {
      dayRollups.set(key, addEntry(dayRollups.get(key), entry, "day", key))
    } else {
      const historyKey = dimensionKey(entry)
      historyRollups.set(
        historyKey,
        addEntry(historyRollups.get(historyKey), entry, "history", historyKey),
      )
    }
  }

  for (const entry of historyEntries) {
    const key = dimensionKey(entry)
    historyRollups.set(
      key,
      addEntry(historyRollups.get(key), entry, "history", key),
    )
  }

  return [...keptRaw, ...dayRollups.values(), ...historyRollups.values()].sort(
    (a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp),
  )
}
