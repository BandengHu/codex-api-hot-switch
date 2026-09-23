import type { ProxyTarget } from "./common"

type AnyRecord = Record<string, any>

const textEncoder = new TextEncoder()

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function splitSseFrame(text: string) {
  const crlf = text.indexOf("\r\n\r\n")
  const lf = text.indexOf("\n\n")
  if (crlf < 0 && lf < 0) return null
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    return { index: crlf, separator: "\r\n\r\n" }
  }
  return { index: lf, separator: "\n\n" }
}

function parseSseFrame(frameText: string) {
  let event = ""
  const data: string[] = []
  for (const line of frameText.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim()
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""))
    }
  }
  return {
    event,
    payload: data.join("\n"),
  }
}

function serializeSseFrame(frameText: string, event: string, payload: AnyRecord) {
  let wroteData = false
  const lineEnding = frameText.includes("\r\n") ? "\r\n" : "\n"
  return frameText.split(/\r?\n/).flatMap((line) => {
    if (line.startsWith("event:")) return [`event: ${event}`]
    if (!line.startsWith("data:")) return [line]
    if (wroteData) return []
    wroteData = true
    return [`data: ${JSON.stringify(payload)}`]
  }).join(lineEnding)
}

function isReasoningPart(part: unknown) {
  return isObject(part) && (
    part.type === "reasoning_text" ||
    part.type === "reasoning"
  )
}

function normalizeReasoningItem(item: AnyRecord) {
  if (item.type !== "reasoning") return false
  if (Array.isArray(item.summary) && item.summary.some(
    (part: unknown) => isObject(part) && typeof part.text === "string" && part.text.length > 0,
  )) {
    return false
  }

  // Keep content as reasoning_text: DeepSeek consumes it on the next turn.
  // summary is a display projection, not a replacement for the original content.
  const summary = Array.isArray(item.content)
    ? item.content.filter((part: unknown) => isReasoningPart(part) && isObject(part))
        .map((part: AnyRecord) => ({
          type: "summary_text",
          text: typeof part.text === "string" ? part.text : "",
        }))
    : []
  if (!summary.some((part) => part.text.length > 0)) {
    if (typeof item.reasoning_content !== "string" || !item.reasoning_content) return false
    item.summary = [{ type: "summary_text", text: item.reasoning_content }]
  } else {
    item.summary = summary
  }
  return true
}

function normalizeReasoningItems(value: unknown) {
  if (!Array.isArray(value)) return false
  let changed = false
  for (const item of value) {
    if (isObject(item)) changed = normalizeReasoningItem(item) || changed
  }
  return changed
}

function normalizePayloadReasoning(data: AnyRecord) {
  let changed = false
  if (isObject(data.item)) {
    changed = normalizeReasoningItem(data.item) || changed
  }
  changed = normalizeReasoningItems(data.output) || changed
  if (isObject(data.response)) {
    changed = normalizeReasoningItems(data.response.output) || changed
  }
  return changed
}

function mapReasoningEventType(type: string, data: AnyRecord) {
  if (type === "response.reasoning_text.delta") {
    return "response.reasoning_summary_text.delta"
  }
  if (type === "response.reasoning_text.done") {
    return "response.reasoning_summary_text.done"
  }
  if (type === "response.reasoning_text.part.added") {
    return "response.reasoning_summary_part.added"
  }
  if (type === "response.reasoning_text.part.done") {
    return "response.reasoning_summary_part.done"
  }
  if (
    (type === "response.content_part.added" || type === "response.content_part.done") &&
    isReasoningPart(data.part)
  ) {
    return type === "response.content_part.added"
      ? "response.reasoning_summary_part.added"
      : "response.reasoning_summary_part.done"
  }
  return ""
}

function normalizeReasoningEvent(data: AnyRecord, event: string) {
  const originalType = typeof data.type === "string" ? data.type : event
  const mappedType = mapReasoningEventType(originalType, data)
  let changed = normalizePayloadReasoning(data)
  if (!mappedType) return { event, data, changed }

  data.type = mappedType
  data.summary_index ??= data.content_index ?? 0
  if (mappedType.startsWith("response.reasoning_summary_part.")) {
    if (isObject(data.part)) {
      data.part.type = "summary_text"
    }
  }
  if (data.content_index != null) {
    delete data.content_index
  }
  changed = true
  return { event: mappedType, data, changed }
}

function normalizeSseFrame(frameText: string) {
  const { event, payload } = parseSseFrame(frameText)
  if (!payload || payload === "[DONE]") return frameText

  let data: AnyRecord
  try {
    data = JSON.parse(payload)
  } catch {
    return frameText
  }
  if (!isObject(data)) return frameText

  const normalized = normalizeReasoningEvent(data, event)
  return normalized.changed
    ? serializeSseFrame(frameText, normalized.event, normalized.data)
    : frameText
}

export function isDeepSeekResponsesThinkingTarget(target: ProxyTarget) {
  if (target.provider.protocol !== "openai-responses") return false
  if (target.provider.rawResponsesPassthrough === true) return false
  // Match the routed model, not a provider label or the pre-switch client slug.
  return /deepseek/i.test(target.modelId) ||
    target.model?.reasoningDialect === "deepseek-official"
}

export function normalizeDeepSeekResponsesSseText(text: string, target: ProxyTarget) {
  if (!isDeepSeekResponsesThinkingTarget(target)) return text
  let buffer = text
  let output = ""
  while (true) {
    const boundary = splitSseFrame(buffer)
    if (!boundary) break
    output += normalizeSseFrame(buffer.slice(0, boundary.index)) + boundary.separator
    buffer = buffer.slice(boundary.index + boundary.separator.length)
  }
  output += normalizeSseFrame(buffer)
  return output
}

export function normalizeDeepSeekResponsesPayload(
  payload: unknown,
  target: ProxyTarget,
) {
  if (!isDeepSeekResponsesThinkingTarget(target) || !isObject(payload)) {
    return payload
  }
  normalizePayloadReasoning(payload)
  return payload
}

export function createDeepSeekResponsesReasoningStream(target: ProxyTarget) {
  if (!isDeepSeekResponsesThinkingTarget(target)) {
    return new TransformStream<Uint8Array, Uint8Array>()
  }

  const textDecoder = new TextDecoder()
  let buffer = ""
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += textDecoder.decode(chunk, { stream: true })
      while (true) {
        const boundary = splitSseFrame(buffer)
        if (!boundary) break
        const frame = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.separator.length)
        controller.enqueue(textEncoder.encode(normalizeSseFrame(frame) + boundary.separator))
      }
    },
    flush(controller) {
      buffer += textDecoder.decode()
      if (buffer) {
        controller.enqueue(textEncoder.encode(normalizeSseFrame(buffer)))
      }
    },
  })
}
