import "server-only"

import { EndpointAttemptError } from "@/lib/server/provider-endpoint-runtime"

const RATE_LIMIT_MESSAGE =
  /^\s*您的使用量已超出频率限制，将在\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+UTC([+-])(\d{1,2})(?::(\d{2}))?\s*重置(?:[，,]\s*您也可以切换其他模型继续使用)?[。.]?\s*$/
const RATE_LIMIT_HEAD = "您的使用量已超出频率限制，将在"
const RATE_LIMIT_SWITCH = "您也可以切换其他模型继续使用"
const RATE_LIMIT_RESET = "重置"

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

interface PrefixStep {
  next: number
  incomplete: boolean
}

function consumeLiteralPrefix(
  text: string,
  start: number,
  literal: string,
): PrefixStep | null {
  for (let index = 0; index < literal.length; index += 1) {
    const cursor = start + index
    if (cursor >= text.length) return { next: text.length, incomplete: true }
    if (text[cursor] !== literal[index]) return null
  }
  return { next: start + literal.length, incomplete: false }
}

function consumeDigitsPrefix(
  text: string,
  start: number,
  count: number,
): PrefixStep | null {
  for (let index = 0; index < count; index += 1) {
    const cursor = start + index
    if (cursor >= text.length) return { next: text.length, incomplete: true }
    if (!/\d/.test(text[cursor])) return null
  }
  return { next: start + count, incomplete: false }
}

function skipPrefixWhitespace(text: string, start: number) {
  let cursor = start
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1
  return cursor
}

function consumeRequiredWhitespacePrefix(
  text: string,
  start: number,
): PrefixStep | null {
  if (start >= text.length) return { next: text.length, incomplete: true }
  if (!/\s/.test(text[start])) return null
  return {
    next: skipPrefixWhitespace(text, start),
    incomplete: false,
  }
}

/**
 * Whether the accumulated assistant text can still become the exact WorkBuddy
 * frequency-limit message. This lets stream priming hold a split message until
 * it either matches completely or proves to be normal output.
 */
export function isWorkbuddyRateLimitPrefix(text: string): boolean {
  const value = text.trimStart()
  let cursor = 0

  const head = consumeLiteralPrefix(value, cursor, RATE_LIMIT_HEAD)
  if (!head) return false
  if (head.incomplete) return true
  const afterHead = consumeRequiredWhitespacePrefix(value, head.next)
  if (!afterHead) return false
  if (afterHead.incomplete) return true
  cursor = afterHead.next

  const year = consumeDigitsPrefix(value, cursor, 4)
  if (!year) return false
  if (year.incomplete) return true
  cursor = year.next
  if (cursor >= value.length) return true
  if (value[cursor] !== "-") return false
  cursor += 1

  const month = consumeDigitsPrefix(value, cursor, 2)
  if (!month) return false
  if (month.incomplete) return true
  cursor = month.next
  if (cursor >= value.length) return true
  if (value[cursor] !== "-") return false
  cursor += 1

  const day = consumeDigitsPrefix(value, cursor, 2)
  if (!day) return false
  if (day.incomplete) return true
  cursor = day.next

  const afterDate = consumeRequiredWhitespacePrefix(value, cursor)
  if (!afterDate) return false
  if (afterDate.incomplete) return true
  cursor = afterDate.next

  for (const separator of [":", ":"] as const) {
    const unit = consumeDigitsPrefix(value, cursor, 2)
    if (!unit) return false
    if (unit.incomplete) return true
    cursor = unit.next
    if (cursor >= value.length) return true
    if (value[cursor] !== separator) return false
    cursor += 1
  }

  const seconds = consumeDigitsPrefix(value, cursor, 2)
  if (!seconds) return false
  if (seconds.incomplete) return true
  cursor = seconds.next

  const afterTime = consumeRequiredWhitespacePrefix(value, cursor)
  if (!afterTime) return false
  if (afterTime.incomplete) return true
  cursor = afterTime.next

  const utc = consumeLiteralPrefix(value, cursor, "UTC")
  if (!utc) return false
  if (utc.incomplete) return true
  cursor = utc.next
  if (cursor >= value.length) return true
  if (value[cursor] !== "+" && value[cursor] !== "-") return false
  cursor += 1

  const hour = consumeDigitsPrefix(value, cursor, 1)
  if (!hour) return false
  if (hour.incomplete) return true
  cursor = hour.next
  if (cursor >= value.length) return true
  if (/\d/.test(value[cursor])) {
    cursor += 1
    if (cursor >= value.length) return true
  }
  if (value[cursor] === ":") {
    const minute = consumeDigitsPrefix(value, cursor + 1, 2)
    if (!minute) return false
    if (minute.incomplete) return true
    cursor = minute.next
  }

  const beforeReset = consumeRequiredWhitespacePrefix(value, cursor)
  if (!beforeReset) return false
  if (beforeReset.incomplete) return true
  cursor = beforeReset.next

  const reset = consumeLiteralPrefix(value, cursor, RATE_LIMIT_RESET)
  if (!reset) return false
  if (reset.incomplete) return true
  cursor = reset.next
  if (cursor >= value.length) return true

  const separator = consumeLiteralPrefix(value, cursor, "，")
  const asciiSeparator = separator
    ? separator
    : consumeLiteralPrefix(value, cursor, ",")
  if (asciiSeparator) {
    if (asciiSeparator.incomplete) return true
    cursor = asciiSeparator.next
    if (cursor >= value.length) return true
    cursor = skipPrefixWhitespace(value, cursor)
    if (cursor >= value.length) return true
    const switchText = consumeLiteralPrefix(value, cursor, RATE_LIMIT_SWITCH)
    if (!switchText) return false
    if (switchText.incomplete) return true
    cursor = switchText.next
    if (cursor >= value.length) return true
  }

  const sentenceEnd =
    consumeLiteralPrefix(value, cursor, "。") ??
    consumeLiteralPrefix(value, cursor, ".")
  if (sentenceEnd?.incomplete) return true
  if (sentenceEnd) cursor = skipPrefixWhitespace(value, sentenceEnd.next)
  return cursor === value.length
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
