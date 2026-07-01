import "server-only"

import { isOpenAIChatProtocol, isOpenAIResponsesProtocol, type ProxyTarget } from "./common"
import {
  containsImageBlocks,
  replaceImageBlocksWithMarker,
} from "./media-sanitizer"

type AnyRecord = Record<string, any>

const MAX_THINKING_BUDGET = 32000
const MAX_TOKENS_FOR_THINKING_BUDGET = 64000
const MIN_MAX_TOKENS_FOR_THINKING_BUDGET = MAX_THINKING_BUDGET + 1

export type RectifierKind =
  | "anthropic-thinking-signature"
  | "anthropic-thinking-budget"
  | "unsupported-image"

export interface RectifiedRequest {
  kind: RectifierKind
  body: unknown
  note: string
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function cloneJsonBody(body: unknown) {
  if (!isObject(body) && !Array.isArray(body)) return body
  return JSON.parse(JSON.stringify(body)) as unknown
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function nestedJsonObject(text: string) {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function pickErrorObject(payload: unknown): unknown {
  if (!isObject(payload)) return payload
  if (isObject(payload.error)) {
    const nestedMessage = safeTrim(payload.error.message)
    const nested = nestedMessage ? nestedJsonObject(nestedMessage) : undefined
    return nested ? pickErrorObject(nested) : payload.error
  }
  if (isObject(payload.base_resp)) return payload.base_resp
  if (isObject(payload.baseResp)) return payload.baseResp
  return payload
}

export function upstreamErrorText(payload: unknown) {
  const error = pickErrorObject(payload)
  if (typeof error === "string") return error
  if (!isObject(error)) return ""
  return (
    safeTrim(error.message) ||
    safeTrim(error.detail) ||
    safeTrim(error.error_description) ||
    safeTrim(error.error) ||
    safeTrim(error.status_msg) ||
    safeTrim(error.statusMessage) ||
    compactJson(error)
  )
}

function shouldRectifyAnthropicThinkingSignature(errorText: string) {
  const lower = errorText.toLowerCase()
  if (!lower) return false
  if (
    lower.includes("invalid") &&
    lower.includes("signature") &&
    lower.includes("thinking") &&
    lower.includes("block")
  ) {
    return true
  }
  if (
    lower.includes("thought signature") &&
    (lower.includes("not valid") || lower.includes("invalid"))
  ) {
    return true
  }
  if (lower.includes("must start with a thinking block")) return true
  if (
    lower.includes("expected") &&
    (lower.includes("thinking") || lower.includes("redacted_thinking")) &&
    lower.includes("found") &&
    lower.includes("tool_use")
  ) {
    return true
  }
  if (lower.includes("signature") && lower.includes("field required")) return true
  if (lower.includes("signature") && lower.includes("extra inputs are not permitted")) return true
  return (
    (lower.includes("thinking") || lower.includes("redacted_thinking")) &&
    lower.includes("cannot be modified")
  )
}

function shouldRectifyAnthropicThinkingBudget(errorText: string) {
  const lower = errorText.toLowerCase()
  if (!lower.includes("thinking")) return false
  const mentionsBudget =
    lower.includes("budget_tokens") || lower.includes("budget tokens")
  if (!mentionsBudget) return false
  return (
    lower.includes("greater than or equal to 1024") ||
    lower.includes(">= 1024") ||
    lower.includes("less than max_tokens") ||
    lower.includes("less than `max_tokens`") ||
    (lower.includes("1024") && lower.includes("input should be"))
  )
}

function isUnsupportedImageError(status: number, errorText: string) {
  if (![400, 415, 422, 501].includes(status)) return false
  const lower = errorText.toLowerCase()
  const mentionsImage =
    lower.includes("image") ||
    lower.includes("vision") ||
    lower.includes("multimodal") ||
    lower.includes("multi-modal") ||
    lower.includes("modality") ||
    lower.includes("modalities") ||
    lower.includes("media") ||
    lower.includes("attachment")
  if (!mentionsImage) return false

  return [
    "unsupported",
    "not supported",
    "does not support",
    "doesn't support",
    "do not support",
    "don't support",
    "only supports text",
    "text only",
    "text-only",
    "invalid content type",
    "invalid message content",
    "unknown variant",
    "unknown content type",
    "unrecognized content type",
    "cannot process",
    "cannot handle",
    "can't process",
    "can't handle",
    "unable to process",
  ].some((hint) => lower.includes(hint))
}

function messageContent(message: unknown) {
  return isObject(message) && Array.isArray(message.content)
    ? message.content
    : undefined
}

function removeOutputConfigEffort(body: AnyRecord) {
  if (!isObject(body.output_config)) return
  delete body.output_config.effort
  if (Object.keys(body.output_config).length === 0) delete body.output_config
}

function lastAssistantMessage(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (isObject(message) && message.role === "assistant") return message
  }
  return undefined
}

function lastAssistantToolUseMissingThinking(body: AnyRecord) {
  if (!Array.isArray(body.messages)) return false
  const assistant = lastAssistantMessage(body.messages)
  const content = messageContent(assistant)
  if (!content || content.length === 0) return false
  const firstType = isObject(content[0]) ? content[0].type : undefined
  if (firstType === "thinking" || firstType === "redacted_thinking") return false
  return content.some((block) => isObject(block) && block.type === "tool_use")
}

function rectifyAnthropicThinkingSignature(body: unknown) {
  if (!isObject(body) || !Array.isArray(body.messages)) return { applied: false, body }
  let removedThinking = 0
  let removedRedactedThinking = 0
  let removedSignatures = 0

  for (const message of body.messages) {
    const content = messageContent(message)
    if (!content) continue
    const nextContent: unknown[] = []
    for (const block of content) {
      if (!isObject(block)) {
        nextContent.push(block)
        continue
      }
      if (block.type === "thinking") {
        removedThinking += 1
        continue
      }
      if (block.type === "redacted_thinking") {
        removedRedactedThinking += 1
        continue
      }
      if (Object.hasOwn(block, "signature")) {
        delete block.signature
        removedSignatures += 1
      }
      nextContent.push(block)
    }
    message.content = nextContent
  }

  let removedTopLevelThinking = false
  const thinkingType = safeTrim(body.thinking?.type)
  if (
    (thinkingType === "enabled" || thinkingType === "adaptive") &&
    lastAssistantToolUseMissingThinking(body)
  ) {
    delete body.thinking
    removeOutputConfigEffort(body)
    removedTopLevelThinking = true
  }

  const applied =
    removedThinking > 0 ||
    removedRedactedThinking > 0 ||
    removedSignatures > 0 ||
    removedTopLevelThinking

  return {
    applied,
    body,
    note: `removed thinking=${removedThinking}, redacted=${removedRedactedThinking}, signatures=${removedSignatures}, top_level=${removedTopLevelThinking}`,
  }
}

function rectifyAnthropicThinkingBudget(body: unknown) {
  if (!isObject(body)) return { applied: false, body }
  const before = {
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    thinkingType: safeTrim(body.thinking?.type),
    budgetTokens: typeof body.thinking?.budget_tokens === "number"
      ? body.thinking.budget_tokens
      : undefined,
  }
  if (before.thinkingType === "adaptive") return { applied: false, body }
  if (!isObject(body.thinking)) body.thinking = {}
  body.thinking.type = "enabled"
  body.thinking.budget_tokens = MAX_THINKING_BUDGET
  if (
    before.maxTokens == null ||
    before.maxTokens < MIN_MAX_TOKENS_FOR_THINKING_BUDGET
  ) {
    body.max_tokens = MAX_TOKENS_FOR_THINKING_BUDGET
  }
  const applied =
    before.thinkingType !== "enabled" ||
    before.budgetTokens !== MAX_THINKING_BUDGET ||
    body.max_tokens !== before.maxTokens
  return {
    applied,
    body,
    note: `max_tokens=${before.maxTokens ?? "missing"}->${body.max_tokens}, budget=${before.budgetTokens ?? "missing"}->${MAX_THINKING_BUDGET}`,
  }
}

function canRectifyAnthropic(target: ProxyTarget) {
  return target.provider.protocol === "anthropic"
}

function canRectifyImages(target: ProxyTarget) {
  return (
    target.provider.protocol === "anthropic" ||
    isOpenAIChatProtocol(target.provider.protocol) ||
    isOpenAIResponsesProtocol(target.provider.protocol)
  )
}

export function maybeRectifyUpstreamError(params: {
  target: ProxyTarget
  status: number
  payload: unknown
  rewrittenBody: unknown
  attempted: Set<RectifierKind>
}): RectifiedRequest | null {
  const errorText = upstreamErrorText(params.payload)

  if (
    canRectifyAnthropic(params.target) &&
    !params.attempted.has("anthropic-thinking-signature") &&
    shouldRectifyAnthropicThinkingSignature(errorText)
  ) {
    const cloned = cloneJsonBody(params.rewrittenBody)
    const rectified = rectifyAnthropicThinkingSignature(cloned)
    if (rectified.applied) {
      return {
        kind: "anthropic-thinking-signature",
        body: rectified.body,
        note: rectified.note || "thinking signature history rectified",
      }
    }
  }

  if (
    canRectifyAnthropic(params.target) &&
    !params.attempted.has("anthropic-thinking-budget") &&
    shouldRectifyAnthropicThinkingBudget(errorText)
  ) {
    const cloned = cloneJsonBody(params.rewrittenBody)
    const rectified = rectifyAnthropicThinkingBudget(cloned)
    if (rectified.applied) {
      return {
        kind: "anthropic-thinking-budget",
        body: rectified.body,
        note: rectified.note || "thinking budget rectified",
      }
    }
  }

  if (
    canRectifyImages(params.target) &&
    !params.attempted.has("unsupported-image") &&
    containsImageBlocks(params.rewrittenBody) &&
    isUnsupportedImageError(params.status, errorText)
  ) {
    const cloned = cloneJsonBody(params.rewrittenBody)
    const replacedImages = replaceImageBlocksWithMarker(cloned)
    if (replacedImages > 0) {
      return {
        kind: "unsupported-image",
        body: cloned,
        note: `replaced_images=${replacedImages}`,
      }
    }
  }

  return null
}
