import "server-only"

import { EndpointAttemptError } from "@/lib/server/provider-endpoint-runtime"

const ACCOUNT_BANNED_CODE = 11140
const ACCOUNT_BANNED_MESSAGE =
  "账号存在异常行为，已被限制使用"

export interface WorkbuddyAccountBan {
  code: number
  message: string
  detectedAt: string
}

export class WorkbuddyAccountBanError extends EndpointAttemptError {
  readonly ban: WorkbuddyAccountBan

  constructor(payload?: unknown, detectedAt = new Date()) {
    const message = accountBanMessage(payload) || ACCOUNT_BANNED_MESSAGE
    const ban = {
      code: ACCOUNT_BANNED_CODE,
      message,
      detectedAt: detectedAt.toISOString(),
    }
    super({
      kind: "auth",
      status: 403,
      message,
      payload: ban,
    })
    this.name = "WorkbuddyAccountBanError"
    this.ban = ban
  }
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return undefined
}

function hasAccountBannedCode(value: unknown, seen: Set<unknown>): boolean {
  if (typeof value === "string") {
    try {
      return hasAccountBannedCode(JSON.parse(value), seen)
    } catch {
      return false
    }
  }
  if (!value || typeof value !== "object" || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    return value.some((item) => hasAccountBannedCode(item, seen))
  }

  const record = value as Record<string, unknown>
  for (const key of ["code", "error_code", "errorCode", "status_code", "statusCode"]) {
    if (numericCode(record[key]) === ACCOUNT_BANNED_CODE) return true
  }
  return Object.values(record).some((item) => hasAccountBannedCode(item, seen))
}

function embeddedJsonValues(text: string) {
  const values: unknown[] = []
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue
    let depth = 0
    let quoted = false
    let escaped = false
    for (let cursor = start; cursor < text.length; cursor += 1) {
      const char = text[cursor]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') {
        quoted = true
        continue
      }
      if (char === "{" || char === "[") depth += 1
      else if (char === "}" || char === "]") {
        depth -= 1
        if (depth === 0) {
          try {
            values.push(JSON.parse(text.slice(start, cursor + 1)))
          } catch {
            // Continue scanning for the next complete JSON value.
          }
          start = cursor
          break
        }
      }
    }
  }
  return values
}

function visitMessage(value: unknown, seen: Set<unknown>): string {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return ""
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const nested = visitMessage(parsed, seen)
      if (nested) return nested
    } catch {
      // Plain error text is the expected form for non-JSON responses.
    }
    if (trimmed.includes(ACCOUNT_BANNED_MESSAGE)) return ACCOUNT_BANNED_MESSAGE
    return trimmed.slice(0, 500)
  }
  if (!value || typeof value !== "object" || seen.has(value)) return ""
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = visitMessage(item, seen)
      if (message) return message
    }
    return ""
  }

  const record = value as Record<string, unknown>
  for (const key of ["message", "msg", "detail", "error_description", "error"]) {
    const message = visitMessage(record[key], seen)
    if (message) return message
  }
  return ""
}

export function isWorkbuddyAccountBanPayload(
  status: number,
  payload: unknown,
): boolean {
  return status === 403 && hasAccountBannedCode(payload, new Set())
}

export function workbuddyAccountBanFromPayload(
  status: number,
  payload: unknown,
): WorkbuddyAccountBanError | null {
  if (!isWorkbuddyAccountBanPayload(status, payload)) return null
  return new WorkbuddyAccountBanError(payload)
}

export function workbuddyAccountBanFromText(status: number, text: string) {
  if (status !== 403) return null
  let payload: unknown = text
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    for (const value of embeddedJsonValues(text)) {
      const error = workbuddyAccountBanFromPayload(status, value)
      if (error) return error
    }
  }
  return workbuddyAccountBanFromPayload(status, payload)
}

export function accountBanMessage(payload: unknown) {
  return visitMessage(payload, new Set())
}
