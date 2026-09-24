import "server-only"

type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function chatUsageToResponsesUsage(usage: unknown) {
  if (!isObject(usage)) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
    }
  }
  const baseInputTokens = Number(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? 0,
  )
  const outputTokens = Number(
    usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0,
  )
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0)
  const cacheCreationTokens =
    Number(usage.cache_creation_input_tokens ?? 0) +
    Number(usage.cache_creation_5m_input_tokens ?? 0) +
    Number(usage.cache_creation_1h_input_tokens ?? 0)
  const cachedTokens = Number(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cachedContentTokenCount ??
      cacheReadTokens ??
      0,
  )
  const hasAnthropicCacheFields =
    usage.cache_read_input_tokens != null ||
    usage.cache_creation_input_tokens != null ||
    usage.cache_creation_5m_input_tokens != null ||
    usage.cache_creation_1h_input_tokens != null
  const hasCacheUsageFields =
    hasAnthropicCacheFields ||
    usage.prompt_tokens_details?.cached_tokens != null ||
    usage.input_tokens_details?.cached_tokens != null ||
    usage.cachedContentTokenCount != null
  const inputTokens = hasAnthropicCacheFields
    ? (Number.isFinite(baseInputTokens) ? baseInputTokens : 0) +
      (Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0) +
      (Number.isFinite(cacheCreationTokens) ? cacheCreationTokens : 0)
    : baseInputTokens
  const computedTotal =
    (Number.isFinite(inputTokens) ? inputTokens : 0) +
    (Number.isFinite(outputTokens) ? outputTokens : 0)
  const reportedTotal = Number(usage.total_tokens ?? usage.totalTokenCount)
  const totalTokens = Number.isFinite(reportedTotal)
    ? Math.max(reportedTotal, computedTotal)
    : computedTotal
  const result: AnyRecord = {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  }
  if (hasCacheUsageFields && Number.isFinite(cachedTokens)) {
    result.input_tokens_details = { cached_tokens: cachedTokens }
  }
  if (Number.isFinite(cacheCreationTokens) && cacheCreationTokens > 0) {
    result.cache_creation_input_tokens = cacheCreationTokens
  }
  if (isObject(usage.completion_tokens_details)) {
    result.output_tokens_details = {
      ...usage.completion_tokens_details,
      reasoning_tokens: Number(usage.completion_tokens_details.reasoning_tokens) || 0,
    }
  } else {
    result.output_tokens_details = { reasoning_tokens: 0 }
  }
  for (const key of [
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_creation_5m_input_tokens",
    "cache_creation_1h_input_tokens",
  ]) {
    if (usage[key] != null) result[key] = usage[key]
  }
  return result
}
