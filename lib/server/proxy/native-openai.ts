import "server-only"

import { encodeAnthropicThinkingBlocks, type AnthropicThinkingBlock } from "./anthropic-thinking"
import { applyAssistantMessagePhase, responseId } from "./common"
import {
  deserializeToolContext,
  toolCallItem,
  type SerializedToolContext,
} from "./codex-tool-proxy"
import { buildChatCompletionPayload } from "./responses-sse"

type AnyRecord = Record<string, any>

export interface NativeOutputText {
  type: "text"
  text: string
}

export interface NativeOutputReasoning {
  type: "reasoning"
  text: string
  anthropicThinkingBlocks?: AnthropicThinkingBlock[]
}

export interface NativeOutputFunctionCall {
  type: "function_call"
  id?: string
  callId: string
  name: string
  argumentsText: string
  geminiThoughtSignature?: string
}

export type NativeOutputItem =
  | NativeOutputText
  | NativeOutputReasoning
  | NativeOutputFunctionCall

export interface NativeOpenAIResponseOptions {
  id?: string
  model: string
  output: NativeOutputItem[]
  usage?: unknown
  status?: "completed" | "incomplete"
  incompleteReason?: string
  reverseToolNameMap?: Record<string, string>
  toolContext?: SerializedToolContext
}

function withReasoningContent(item: AnyRecord, reasoningContent = "") {
  const text = reasoningContent.trim()
  return text ? { ...item, reasoning_content: text } : item
}

function messageItem(text: string) {
  return {
    type: "message",
    id: responseId("msg"),
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }],
  }
}

function reasoningItem(text: string, anthropicThinkingBlocks?: AnthropicThinkingBlock[]) {
  const encryptedContent = anthropicThinkingBlocks
    ? encodeAnthropicThinkingBlocks(anthropicThinkingBlocks)
    : undefined
  return {
    type: "reasoning",
    id: responseId("rs"),
    status: "completed",
    summary: [{ type: "summary_text", text }],
    ...(encryptedContent ? { encrypted_content: encryptedContent } : {}),
  }
}

function withGeminiThoughtSignature(item: AnyRecord, signature?: string) {
  const text = typeof signature === "string" ? signature.trim() : ""
  return text ? { ...item, gemini_thought_signature: text } : item
}

function functionCallItem(
  item: NativeOutputFunctionCall,
  options: Pick<NativeOpenAIResponseOptions, "reverseToolNameMap" | "toolContext"> = {},
  reasoningContent = "",
) {
  const name = options.reverseToolNameMap?.[item.name] || item.name
  const context = options.toolContext ? deserializeToolContext(options.toolContext) : null
  if (context && (context.customTools.size > 0 || context.functionTools.size > 0 || context.toolSearchTools.size > 0)) {
    return withGeminiThoughtSignature(
      toolCallItem(item.callId, name, item.argumentsText || "{}", context, reasoningContent),
      item.geminiThoughtSignature,
    )
  }
  return withGeminiThoughtSignature(withReasoningContent({
    type: "function_call",
    id: item.id || item.callId,
    call_id: item.callId,
    name,
    arguments: item.argumentsText || "{}",
    status: "completed",
  }, reasoningContent), item.geminiThoughtSignature)
}

export function buildOpenAIResponseFromNative(options: NativeOpenAIResponseOptions) {
  const output: AnyRecord[] = []
  let outputText = ""
  let latestReasoningText = ""

  for (const item of options.output) {
    if (item.type === "text") {
      outputText += item.text
      output.push(messageItem(item.text))
    } else if (item.type === "reasoning") {
      latestReasoningText += item.text
      output.push(reasoningItem(item.text, item.anthropicThinkingBlocks))
    } else if (item.type === "function_call") {
      output.push(functionCallItem(item, options, latestReasoningText))
    }
  }

  const status = options.status || "completed"
  applyAssistantMessagePhase(output)
  return {
    id: options.id || responseId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: options.model,
    output,
    output_text: outputText,
    usage: options.usage || undefined,
    incomplete_details:
      status === "incomplete"
        ? { reason: options.incompleteReason || "max_output_tokens" }
        : undefined,
  }
}

export function buildOpenAIChatFromNativeResponse(
  response: unknown,
  requestedModel: string,
  reverseToolNameMap: Record<string, string> = {},
) {
  return buildChatCompletionPayload(response, requestedModel, reverseToolNameMap)
}

export function openAIUsageFromAnthropic(usage: unknown) {
  if (!usage || typeof usage !== "object") return undefined
  const record = usage as AnyRecord
  const inputTokens = Number(record.input_tokens ?? 0)
  const outputTokens = Number(record.output_tokens ?? 0)
  const cacheReadTokens = Number(record.cache_read_input_tokens ?? 0)
  const cacheCreationTokens =
    Number(record.cache_creation_input_tokens ?? 0) +
    Number(record.cache_creation_5m_input_tokens ?? 0) +
    Number(record.cache_creation_1h_input_tokens ?? 0)
  const totalInputTokens =
    (Number.isFinite(inputTokens) ? inputTokens : 0) +
    (Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0) +
    (Number.isFinite(cacheCreationTokens) ? cacheCreationTokens : 0)
  const result: AnyRecord = {
    input_tokens: totalInputTokens,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: totalInputTokens + (Number.isFinite(outputTokens) ? outputTokens : 0),
    output_tokens_details: { reasoning_tokens: 0 },
  }
  if (Number.isFinite(cacheReadTokens) && cacheReadTokens > 0) {
    result.input_tokens_details = { cached_tokens: cacheReadTokens }
  }
  if (Number.isFinite(cacheCreationTokens) && cacheCreationTokens > 0) {
    result.cache_creation_input_tokens = cacheCreationTokens
  }
  return result
}

export function openAIUsageFromGemini(usage: unknown) {
  if (!usage || typeof usage !== "object") return undefined
  const record = usage as AnyRecord
  const inputTokens = Number(record.promptTokenCount ?? record.inputTokenCount ?? 0)
  const outputTokens = Number(
    record.candidatesTokenCount ?? record.outputTokenCount ?? 0,
  )
  const totalTokens = Number(record.totalTokenCount ?? inputTokens + outputTokens)
  const result: AnyRecord = {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens)
      ? totalTokens
      : (Number.isFinite(inputTokens) ? inputTokens : 0) +
        (Number.isFinite(outputTokens) ? outputTokens : 0),
    output_tokens_details: { reasoning_tokens: 0 },
  }
  const cachedTokens = Number(record.cachedContentTokenCount ?? 0)
  if (Number.isFinite(cachedTokens) && cachedTokens > 0) {
    result.input_tokens_details = { cached_tokens: cachedTokens }
  }
  return result
}
