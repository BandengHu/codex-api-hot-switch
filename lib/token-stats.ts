import type { RequestLog, TokenStatEntry, TokenUsage } from "@/lib/types"

export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
  requests: number
}

export function emptyTokenTotals(): TokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    requests: 0,
  }
}

export function tokenUsageTotal(usage: TokenUsage | undefined) {
  if (!usage) return 0
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

export function tokenStatFromLog(log: RequestLog): TokenStatEntry | undefined {
  if (!log.tokenUsage) return undefined
  return {
    id: `token-${log.id}`,
    timestamp: log.timestamp,
    providerId: log.finalProviderId,
    modelId: log.finalModelId,
    codexModel: log.codexModel,
    statusCode: log.statusCode,
    inputTokens: log.tokenUsage.inputTokens ?? 0,
    outputTokens: log.tokenUsage.outputTokens ?? 0,
    totalTokens: tokenUsageTotal(log.tokenUsage),
    cachedInputTokens: log.tokenUsage.cachedInputTokens ?? 0,
    cacheCreationInputTokens: log.tokenUsage.cacheCreationInputTokens ?? 0,
    reasoningTokens: log.tokenUsage.reasoningTokens ?? 0,
  }
}

export function addTokenEntry(total: TokenTotals, entry: TokenStatEntry): TokenTotals {
  return {
    inputTokens: total.inputTokens + entry.inputTokens,
    outputTokens: total.outputTokens + entry.outputTokens,
    totalTokens: total.totalTokens + entry.totalTokens,
    cachedInputTokens: total.cachedInputTokens + entry.cachedInputTokens,
    cacheCreationInputTokens:
      total.cacheCreationInputTokens + entry.cacheCreationInputTokens,
    reasoningTokens: total.reasoningTokens + entry.reasoningTokens,
    requests: total.requests + 1,
  }
}

export function sumTokenStats(entries: TokenStatEntry[]): TokenTotals {
  return entries.reduce(addTokenEntry, emptyTokenTotals())
}

export function tokenStatsSince(
  entries: TokenStatEntry[],
  resetAt: string | undefined,
) {
  const resetTime = Date.parse(resetAt || "")
  if (!Number.isFinite(resetTime)) return entries
  return entries.filter((entry) => {
    const timestamp = Date.parse(entry.timestamp)
    return Number.isFinite(timestamp) && timestamp >= resetTime
  })
}

export function formatTokenCount(value: number | undefined) {
  if (value == null) return "—"
  return new Intl.NumberFormat("zh-CN").format(value)
}
