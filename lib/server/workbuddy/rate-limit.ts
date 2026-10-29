import "server-only"

import { EndpointAttemptError } from "@/lib/server/provider-endpoint-runtime"

const RATE_LIMIT_MESSAGE =
  /^\s*您的使用量已超出频率限制，将在\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+UTC([+-])(\d{1,2})(?::(\d{2}))?\s*重置(?:[，,]\s*您也可以切换其他模型继续使用)?[。.]?\s*$/

export interface WorkbuddyRateLimit {
  message: string
  resetAt: string
}

export class WorkbuddyRateLimitError extends EndpointAttemptError {
  readonly rateLimit: WorkbuddyRateLimit

  constructor(rateLimit: WorkbuddyRateLimit) {
    super({
      kind: "quota",
      status: 429,
      message: rateLimit.message,
      payload: rateLimit,
    })
    this.name = "WorkbuddyRateLimitError"
    this.rateLimit = rateLimit
  }
}

function parseRateLimit(text: string): WorkbuddyRateLimit | null {
  const match = text.match(RATE_LIMIT_MESSAGE)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHours = Number(match[8])
  const offsetMinutes = Number(match[9] || 0)
  const localTime = Date.UTC(year, month - 1, day, hour, minute, second)
  const localDate = new Date(localTime)
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second ||
    offsetHours > 14 ||
    offsetMinutes > 59
  ) {
    return null
  }
  const sign = match[7] === "+" ? 1 : -1
  return {
    message: match[0].trim(),
    resetAt: new Date(
      localTime - sign * (offsetHours * 60 + offsetMinutes) * 60_000,
    ).toISOString(),
  }
}

/** Detect only the exact WorkBuddy model-frequency response, not generic quota errors. */
export function workbuddyRateLimitFromText(text: string): WorkbuddyRateLimit | null {
  const direct = parseRateLimit(text)
  if (direct) return direct
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null
  try {
    return workbuddyRateLimitFromPayload(JSON.parse(trimmed))
  } catch {
    return null
  }
}

export function workbuddyRateLimitFromPayload(payload: unknown): WorkbuddyRateLimit | null {
  const seen = new Set<unknown>()
  const visit = (value: unknown): WorkbuddyRateLimit | null => {
    if (typeof value === "string") return parseRateLimit(value)
    if (!value || typeof value !== "object" || seen.has(value)) return null
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) {
        const result = visit(item)
        if (result) return result
      }
      return null
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      const result = visit(item)
      if (result) return result
    }
    return null
  }
  return visit(payload)
}
