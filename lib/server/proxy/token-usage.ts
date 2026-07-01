import "server-only"

import type { TokenUsage } from "@/lib/types"

type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function finiteToken(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined
}

function firstToken(...values: unknown[]) {
  for (const value of values) {
    const token = finiteToken(value)
    if (token != null) return token
  }
  return undefined
}

function sumTokens(...values: unknown[]) {
  let total = 0
  let found = false
  for (const value of values) {
    const token = finiteToken(value)
    if (token == null) continue
    total += token
    found = true
  }
  return found ? total : undefined
}

export function normalizeTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined

  const inputTokens = firstToken(
    value.input_tokens,
    value.prompt_tokens,
    value.promptTokenCount,
  )
  const outputTokens = firstToken(
    value.output_tokens,
    value.completion_tokens,
    value.candidatesTokenCount,
  )
  const cachedInputTokens = firstToken(
    value.input_tokens_details?.cached_tokens,
    value.prompt_tokens_details?.cached_tokens,
    value.cachedContentTokenCount,
    value.cache_read_input_tokens,
  )
  const cacheCreationInputTokens = sumTokens(
    value.cache_creation_input_tokens,
    value.cache_creation_5m_input_tokens,
    value.cache_creation_1h_input_tokens,
  )
  const rawAnthropicCacheFields =
    (value.cache_read_input_tokens != null ||
      value.cache_creation_input_tokens != null ||
      value.cache_creation_5m_input_tokens != null ||
      value.cache_creation_1h_input_tokens != null) &&
    value.total_tokens == null &&
    value.input_tokens_details?.cached_tokens == null &&
    value.prompt_tokens_details?.cached_tokens == null
  const fullInputTokens = rawAnthropicCacheFields
    ? (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0)
    : inputTokens
  const totalTokens =
    firstToken(value.total_tokens, value.totalTokenCount) ??
    (fullInputTokens != null || outputTokens != null
      ? (fullInputTokens ?? 0) + (outputTokens ?? 0)
      : undefined)
  const reasoningTokens = firstToken(
    value.output_tokens_details?.reasoning_tokens,
    value.completion_tokens_details?.reasoning_tokens,
    value.reasoning_tokens,
  )

  if (
    inputTokens == null &&
    outputTokens == null &&
    totalTokens == null &&
    cachedInputTokens == null &&
    cacheCreationInputTokens == null &&
    reasoningTokens == null
  ) {
    return undefined
  }

  return {
    inputTokens: fullInputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    reasoningTokens,
  }
}

export function extractTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined

  return (
    normalizeTokenUsage(value.usage) ||
    normalizeTokenUsage(value.response?.usage) ||
    normalizeTokenUsage(value.usageMetadata) ||
    normalizeTokenUsage(value)
  )
}

function splitSseFrame(text: string) {
  const crlf = text.indexOf("\r\n\r\n")
  const lf = text.indexOf("\n\n")
  if (crlf < 0 && lf < 0) return null
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    return { index: crlf, separatorLength: 4 }
  }
  return { index: lf, separatorLength: 2 }
}

interface SseFrameInfo {
  usage?: TokenUsage
  terminal?: string
}

// 单次解析同一帧，同时得出 usage 与终态，避免对每个 SSE 帧重复 split + JSON.parse。
function parseSseFrameInfo(frameText: string): SseFrameInfo {
  const data: string[] = []
  for (const rawLine of frameText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  const payload = data.join("\n").trim()
  if (!payload) return {}
  if (payload === "[DONE]") return { terminal: "done" }
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return {}
  }
  const info: SseFrameInfo = {}
  info.usage = extractTokenUsage(parsed)
  const type = isObject(parsed) ? String(parsed.type || "") : ""
  if (type === "response.completed" || type === "response.done") info.terminal = "completed"
  else if (type === "response.failed") info.terminal = "failed"
  return info
}

export class TokenUsageSseCollector {
  private decoder = new TextDecoder()
  private buffer = ""
  private usage: TokenUsage | undefined
  private terminalType: string | undefined

  push(chunk: Uint8Array) {
    if (!chunk.length) return
    this.buffer += this.decoder.decode(chunk, { stream: true })
    this.flushFrames()
  }

  finish() {
    this.buffer += this.decoder.decode()
    if (this.buffer.trim()) {
      const info = parseSseFrameInfo(this.buffer)
      this.usage = info.usage || this.usage
      this.recordTerminal(info.terminal)
    }
    this.buffer = ""
    return this.usage
  }

  current() {
    return this.usage
  }

  terminal() {
    return this.terminalType
  }

  private flushFrames() {
    while (true) {
      const boundary = splitSseFrame(this.buffer)
      if (!boundary) break
      const frameText = this.buffer.slice(0, boundary.index)
      this.buffer = this.buffer.slice(boundary.index + boundary.separatorLength)
      const info = parseSseFrameInfo(frameText)
      this.usage = info.usage || this.usage
      this.recordTerminal(info.terminal)
    }
  }

  // response.completed / response.failed 是权威终态；[DONE] 只是流终止标记。
  // 上游会在 response.completed 之后再发 [DONE]，若直接覆盖会把已识别的
  // 终态误报成 done，导致日志出现“没有看到 response.completed”。
  private recordTerminal(next: string | undefined) {
    if (!next) return
    if (next === "done") {
      if (!this.terminalType) this.terminalType = "done"
      return
    }
    this.terminalType = next
  }
}

export function extractTokenUsageFromSseText(text: string): TokenUsage | undefined {
  let usage: TokenUsage | undefined
  let buffer = String(text || "")
  while (true) {
    const boundary = splitSseFrame(buffer)
    if (!boundary) break
    const frameText = buffer.slice(0, boundary.index)
    buffer = buffer.slice(boundary.index + boundary.separatorLength)
    usage = parseSseFrameInfo(frameText).usage || usage
  }
  if (buffer.trim()) usage = parseSseFrameInfo(buffer).usage || usage
  return usage
}
