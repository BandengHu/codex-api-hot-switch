import type { RequestLog } from "./types"

export interface RateLimitLogHint {
  timestamp: string
  modelId: string
  message: string
  resetAt?: string
}

const RATE_LIMIT_PATTERN = /频率限制|rate.?limit/i
const RESET_PATTERN = /将在\s*(.+?)\s*(?:UTC[+-]\d+(?::\d+)?)?\s*重置/

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined
  const text = value.trim()
  if (!text.startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function upstreamMessage(value: string) {
  const direct = value.trim()
  if (!direct) return ""
  // 旧日志的 responseSummary 可能保留上游嵌套体：
  // {"error":{"message":"{\"code\":6004,\"msg\":\"...\"}"}}。
  const payload = parseJsonObject(direct)
  const error = payload?.error
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const record = error as Record<string, unknown>
    if (typeof record.message === "string") {
      const nested = parseJsonObject(record.message)
      if (nested && typeof nested.msg === "string") return nested.msg.trim()
      return record.message.trim()
    }
  }
  const nested = parseJsonObject(direct)
  if (nested && typeof nested.msg === "string") return nested.msg.trim()
  return direct
}

function rateLimitMessage(log: RequestLog) {
  for (const value of [log.error, log.responseSummary]) {
    const message = upstreamMessage(value || "")
    if (message && RATE_LIMIT_PATTERN.test(message)) return message
  }
  return ""
}

export function extractRateLimitResetAt(message: string) {
  return message.match(RESET_PATTERN)?.[1]?.trim()
}

export function latestRateLimitHint(logs: RequestLog[]): RateLimitLogHint | null {
  let latest: RateLimitLogHint | null = null
  for (const log of logs) {
    if (log.statusCode !== 429) continue
    const message = rateLimitMessage(log)
    if (!message) continue
    const resetAt = extractRateLimitResetAt(message)
    const current: RateLimitLogHint = {
      timestamp: log.timestamp,
      modelId: log.finalModelId,
      message,
      ...(resetAt ? { resetAt } : {}),
    }
    if (!latest || Date.parse(current.timestamp) > Date.parse(latest.timestamp)) {
      latest = current
    }
  }
  return latest
}
