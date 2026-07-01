import "server-only"

import {
  applyAssistantMessagePhase,
  isChatCompletionsPath,
  isResponsesPath,
  joinUrl,
  providerHeaders,
  responseId,
  type ProxyTarget,
} from "./common"
import {
  buildChatCompletionPayload,
  createChatCompletionsSseStream,
  extractFinalResponseFromSse,
  extractOutputText,
  responsesSseToChatCompletionsSse,
  transformResponsesSseText,
} from "./responses-sse"
import {
  applyChatPassthroughReasoningOverride,
  applyChatReasoningOptions,
  isOpenAIOModel,
  resolveReasoningDialect,
  setCanonicalReasoning,
} from "./reasoning-dialects"
import {
  canonicalJson,
  canonicalToolArguments,
  canonicalToolArgumentsString,
} from "./json-canonical"
import { lastCompleteSseFrameBoundary } from "./sse-frame"
import {
  enrichCodexChatRequest,
  recordCodexChatResponse,
} from "./codex-chat-history"
import {
  appendOutputLanguagePolicyToChatBody,
  appendOutputLanguagePolicyToLatestChatUserMessage,
  appendOutputLanguagePolicyToResponsesBody,
} from "./language-policy"
import {
  buildCustomToolCallHistory,
  buildToolContext,
  collectToolSearchOutputTools,
  deserializeToolContext,
  flattenNamespaceToolName,
  isCustomToolProxy,
  isToolChoiceWithNoSurvivingTool,
  rememberResponseTool,
  responsesToolChoiceToChat,
  responsesToolsToChatTools,
  serializeToolContext,
  toolCallAddedItem,
  toolCallItem,
  toolCallItemId,
  type SerializedToolContext,
  type ToolContext,
} from "./codex-tool-proxy"

type AnyRecord = Record<string, any>

const RESPONSE_ECHO_FIELDS = [
  "instructions",
  "max_output_tokens",
  "parallel_tool_calls",
  "previous_response_id",
  "reasoning",
  "temperature",
  "tool_choice",
  "tools",
  "top_p",
  "metadata",
] as const

export type ChatCompatibleAdapter =
  | {
      type: "chat_compatible"
      source: "responses"
      requestIsStream: boolean
      originalRequest: AnyRecord
      toolContext: SerializedToolContext
    }
  | {
      type: "chat_compatible_passthrough"
      source: "chat_completions"
      requestIsStream: boolean
      requestedModel: string
      reverseToolNameMap: Record<string, string>
    }

export interface ChatCompatibleBuiltRequest {
  url: string
  init: RequestInit
  rewrittenBody: unknown
  adapter: ChatCompatibleAdapter
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function contentToText(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (isObject(part) && typeof part.text === "string") return part.text
        if (isObject(part) && typeof part.content === "string") return part.content
        if (isObject(part) && typeof part.refusal === "string") return part.refusal
        return JSON.stringify(part)
      })
      .filter(Boolean)
      .join("")
  }
  return JSON.stringify(content)
}

function outputText(value: unknown) {
  if (typeof value === "string") return value
  if (value == null) return ""
  return canonicalJson(value)
}

function instructionText(value: unknown) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return safeTrim(value)
  return value
    .map((part) => {
      if (typeof part === "string") return part
      if (isObject(part)) return safeTrim(part.text) || safeTrim(part.content)
      return ""
    })
    .filter(Boolean)
    .join("\n\n")
}

function responseRoleToChat(role: unknown) {
  const value = safeTrim(role).toLowerCase()
  if (value === "developer" || value === "system") return "system"
  if (value === "assistant") return "assistant"
  if (value === "tool") return "tool"
  return "user"
}

function responseContentToChatContent(role: string, content: unknown) {
  if (content == null || typeof content === "string") return content ?? ""
  if (!Array.isArray(content)) return content

  const parts: AnyRecord[] = []
  let hasNonText = false
  for (const part of content) {
    if (!isObject(part)) continue
    const type = safeTrim(part.type)
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = safeTrim(part.text)
      if (text) {
        parts.push({ type: "text", text })
      }
    } else if (type === "refusal") {
      const text = safeTrim(part.refusal)
      if (text) parts.push({ type: "text", text })
    } else if (type === "input_image" || type === "image_url") {
      const imageUrl = isObject(part.image_url)
        ? part.image_url
        : { url: safeTrim(part.image_url || part.url) }
      parts.push({ type: "image_url", image_url: imageUrl })
      hasNonText = true
    } else if (type === "input_file") {
      const file = responsesInputFileToChatFile(part)
      if (file) {
        parts.push({ type: "file", file })
        hasNonText = true
      }
    } else if (type === "input_audio") {
      if (isObject(part.input_audio)) {
        parts.push({ type: "input_audio", input_audio: part.input_audio })
        hasNonText = true
      }
    }
  }

  if (!hasNonText) {
    return parts.map((part) => part.text).filter(Boolean).join("\n")
  }
  return role === "assistant" ? parts.filter((part) => part.type === "text") : parts
}

function responsesInputFileToChatFile(part: AnyRecord) {
  if (part.file_id == null && part.file_data == null) return null
  const file: AnyRecord = {}
  for (const key of ["file_id", "file_data", "filename"] as const) {
    if (part[key] != null) file[key] = part[key]
  }
  return file
}

function extractReasoningItemText(value: unknown): string {
  if (!isObject(value)) return ""
  for (const key of ["reasoning_content", "content", "text"]) {
    const text = safeTrim(value[key])
    if (text) return text
  }
  return extractReasoningFields(value)
}

function extractEmbeddedReasoningText(value: unknown): string {
  if (!isObject(value)) return ""
  const direct = safeTrim(value.reasoning_content)
  return direct || extractReasoningFields(value)
}

function extractChatReasoningText(value: unknown): string {
  if (!isObject(value)) return ""
  const direct = safeTrim(value.reasoning_content)
  if (direct) return direct
  return extractReasoningFields(value)
}

function extractReasoningFields(value: AnyRecord): string {
  const reasoning = value.reasoning
  if (typeof reasoning === "string" && reasoning.trim()) return reasoning
  if (isObject(reasoning)) {
    for (const key of ["content", "text", "summary"]) {
      const text = safeTrim(reasoning[key])
      if (text) return text
    }
  }
  const summary = value.summary
  if (typeof summary === "string" && summary.trim()) return summary
  if (Array.isArray(summary)) {
    return summary
      .map((part) => {
        if (typeof part === "string") return part
        if (isObject(part)) return safeTrim(part.text) || safeTrim(part.content)
        return ""
      })
      .filter(Boolean)
      .join("\n\n")
  }
  const details = value.reasoning_details
  if (Array.isArray(details)) {
    return details.map(extractReasoningDetailText).filter(Boolean).join("\n\n")
  }
  return extractReasoningDetailText(details)
}

function chatPayloadContentText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      if (typeof part === "string") return part
      if (!isObject(part)) return ""
      if (typeof part.text === "string") return part.text
      if (typeof part.content === "string") return part.content
      if (typeof part.refusal === "string") return part.refusal
      return ""
    })
    .join("")
}

function extractReasoningDetailText(value: unknown): string {
  if (typeof value === "string") return value
  if (!isObject(value)) return ""
  for (const key of ["summary", "text", "content"]) {
    const text = safeTrim(value[key])
    if (text) return text
  }
  if (Array.isArray(value.parts)) {
    return value.parts.map(extractReasoningDetailText).filter(Boolean).join("\n\n")
  }
  return ""
}

function responsesTextFormatToChatResponseFormat(body: AnyRecord) {
  if (isObject(body.response_format)) return body.response_format
  const format = body.text?.format
  if (!isObject(format)) return undefined
  if (format.type === "json_object") return { type: "json_object" }
  if (format.type === "json_schema") {
    const { type, name, schema, strict, description } = format
    if (!isObject(schema)) return undefined
    return {
      type,
      json_schema: {
        ...(typeof name === "string" && name.trim() ? { name } : {}),
        ...(typeof description === "string" && description.trim() ? { description } : {}),
        schema,
        ...(typeof strict === "boolean" ? { strict } : {}),
      },
    }
  }
  return undefined
}

function callIdFromItem(item: AnyRecord) {
  return safeTrim(item.call_id || item.id || item.tool_call_id || item.item_id)
}

function responsesHistoryFunctionName(item: AnyRecord) {
  const name = safeTrim(item.name)
  const namespace = safeTrim(item.namespace)
  return name && namespace ? flattenNamespaceToolName(namespace, name) : name
}

function responseArgumentsToChat(value: unknown) {
  return canonicalToolArguments(value)
}

function orphanToolOutputMessage(callId: string, output: unknown) {
  return {
    role: "user",
    content: `Function call output (${callId}): ${outputText(output)}`,
  }
}

function appendReasoningToAssistant(message: AnyRecord, reasoning: string) {
  const existing = safeTrim(message.reasoning_content)
  message.reasoning_content = existing ? `${existing}\n${reasoning}` : reasoning
  if (message.content == null) message.content = ""
}

function appendPendingReasoning(pendingReasoning: string[], reasoning: string) {
  const text = reasoning.trim()
  if (text) pendingReasoning.push(text)
}

function appendUniquePendingReasoning(pendingReasoning: string[], reasoning: string) {
  const text = reasoning.trim()
  if (!text || pendingReasoning.some((existing) => existing.includes(text))) return
  pendingReasoning.push(text)
}

function appendResponsesInput(input: unknown, messages: AnyRecord[]) {
  const pendingToolCalls: AnyRecord[] = []
  const pendingReasoning: string[] = []
  const seenToolCallIds = new Set<string>()
  let lastAssistantIndex: number | null = null

  const pushMessage = (message: AnyRecord) => {
    if (message.role === "assistant") {
      lastAssistantIndex = messages.length
    } else if (message.role !== "tool") {
      lastAssistantIndex = null
    }
    messages.push(message)
  }

  const attachReasoningToLastAssistant = (reasoning: string) => {
    const text = reasoning.trim()
    if (!text || lastAssistantIndex == null) return false
    const message = messages[lastAssistantIndex]
    if (!message || message.role !== "assistant") return false
    appendReasoningToAssistant(message, text)
    return true
  }

  const flushReasoning = () => {
    if (pendingReasoning.length === 0) return
    const reasoning = pendingReasoning.splice(0).join("\n\n")
    attachReasoningToLastAssistant(reasoning)
  }

  const flushToolCalls = () => {
    if (pendingToolCalls.length === 0) return
    const incoming = pendingToolCalls.splice(0)
    const message: AnyRecord = { role: "assistant", content: "", tool_calls: incoming }
    if (pendingReasoning.length > 0) {
      message.reasoning_content = pendingReasoning.splice(0).join("\n\n")
    }
    pushMessage(message)
  }

  const appendItem = (raw: unknown) => {
    if (!isObject(raw)) return
    const type = safeTrim(raw.type || (raw.role || raw.content ? "message" : ""))

    if (type === "input_text" || type === "input_image" || type === "input_file" || type === "input_audio") {
      flushToolCalls()
      const role = responseRoleToChat(raw.role)
      const message: AnyRecord = {
        role,
        content: responseContentToChatContent(role, [raw]),
      }
      if (role === "assistant") {
        appendPendingReasoning(pendingReasoning, extractEmbeddedReasoningText(raw))
        if (pendingReasoning.length > 0) {
          message.reasoning_content = pendingReasoning.splice(0).join("\n\n")
        }
      } else if (pendingReasoning.length > 0) {
        pendingReasoning.splice(0)
      }
      pushMessage(message)
      return
    }

    if (type === "function_call") {
      appendUniquePendingReasoning(pendingReasoning, extractEmbeddedReasoningText(raw))
      const name = responsesHistoryFunctionName(raw)
      const callId = callIdFromItem(raw)
      if (!name || !callId) return
      seenToolCallIds.add(callId)
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: {
          name,
          arguments: responseArgumentsToChat(raw.arguments ?? {}),
        },
      })
      return
    }

    if (type === "custom_tool_call") {
      appendUniquePendingReasoning(pendingReasoning, extractEmbeddedReasoningText(raw))
      const callId = callIdFromItem(raw)
      if (!callId) return
      const built = buildCustomToolCallHistory(safeTrim(raw.name) || "custom_tool", raw.input ?? raw.arguments)
      seenToolCallIds.add(callId)
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: { name: built.name, arguments: built.arguments },
      })
      return
    }

    if (type === "tool_search_call") {
      appendUniquePendingReasoning(pendingReasoning, extractEmbeddedReasoningText(raw))
      const callId = callIdFromItem(raw)
      if (!callId) return
      seenToolCallIds.add(callId)
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: {
          name: "tool_search",
          arguments: responseArgumentsToChat(raw.arguments ?? {}),
        },
      })
      return
    }

    if (
      type === "function_call_output" ||
      type === "custom_tool_call_output" ||
      type === "tool_search_output"
    ) {
      const callId = callIdFromItem(raw)
      if (!callId) return
      flushToolCalls()
      if (!seenToolCallIds.has(callId)) {
        flushReasoning()
        pushMessage(orphanToolOutputMessage(callId, raw.output ?? raw.content ?? ""))
        return
      }
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content:
          type === "tool_search_output"
            ? canonicalJson(raw)
            : outputText(raw.output ?? raw.content ?? ""),
      })
      return
    }

    if (type === "tool_call" && isObject(raw.tool_use)) {
      const callId = callIdFromItem(raw.tool_use) || callIdFromItem(raw)
      const name = safeTrim(raw.tool_use.name)
      if (!callId || !name) return
      seenToolCallIds.add(callId)
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: {
          name,
          arguments: responseArgumentsToChat(raw.tool_use.input ?? {}),
        },
      })
      return
    }

    if (type === "tool_result") {
      const content = isObject(raw.content) ? raw.content : raw
      const callId = safeTrim(content.tool_use_id || raw.tool_call_id || raw.call_id)
      if (!callId) return
      flushToolCalls()
      const output = isObject(content) && Object.hasOwn(content, "content") ? content.content : content
      if (!seenToolCallIds.has(callId)) {
        flushReasoning()
        pushMessage(orphanToolOutputMessage(callId, output))
        return
      }
      pushMessage({ role: "tool", tool_call_id: callId, content: outputText(output) })
      return
    }

    if (type === "reasoning") {
      const reasoning = extractReasoningItemText(raw)
      if (reasoning) {
        const attachedToPrevious =
          pendingToolCalls.length === 0 && attachReasoningToLastAssistant(reasoning)
        if (!attachedToPrevious) appendPendingReasoning(pendingReasoning, reasoning)
      }
      return
    }

    flushToolCalls()
    if (!Object.hasOwn(raw, "role") && !Object.hasOwn(raw, "content")) return
    const role = responseRoleToChat(raw.role)
    const message: AnyRecord = {
      role,
      content: responseContentToChatContent(role, raw.content),
    }
    if (role === "assistant") {
      appendPendingReasoning(pendingReasoning, extractEmbeddedReasoningText(raw))
      if (pendingReasoning.length > 0) {
        message.reasoning_content = pendingReasoning.splice(0).join("\n\n")
      }
    } else if (pendingReasoning.length > 0) {
      pendingReasoning.splice(0)
    }
    pushMessage(message)
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
  } else if (Array.isArray(input)) {
    input.forEach(appendItem)
  } else if (isObject(input)) {
    appendItem(input)
  }
  flushToolCalls()
  flushReasoning()
}

function normalizeChatMessages(messages: AnyRecord[]) {
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const hasContent =
      message.content != null &&
      !(Array.isArray(message.content) && message.content.length === 0)
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    if (!hasContent && !hasToolCalls) message.content = ""
  }
}

function shouldBackfillToolCallReasoning(target: ProxyTarget) {
  const dialect = resolveReasoningDialect(target)
  if (target.reasoning === "off") return false
  return (
    dialect === "deepseek-official" ||
    dialect === "qwen-enable-thinking" ||
    dialect === "kimi-thinking" ||
    dialect === "glm-thinking"
  )
}

function backfillToolCallReasoningPlaceholders(messages: AnyRecord[], target: ProxyTarget) {
  if (!shouldBackfillToolCallReasoning(target)) return
  for (const message of messages) {
    const isAssistantToolCall =
      message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    if (!isAssistantToolCall) continue
    const reasoning = safeTrim(message.reasoning_content)
    if (!reasoning) message.reasoning_content = "tool call"
    if (message.content == null) message.content = ""
  }
}

function supportsChatResponseFormat(target: ProxyTarget, model: string) {
  const dialect = resolveReasoningDialect(target)
  const hint = `${target.provider.name} ${target.provider.baseUrl} ${target.provider.protocol} ${model}`.toLowerCase()
  if (dialect === "deepseek-official" || hint.includes("deepseek")) return false
  return true
}

function collapseSystemMessagesToHead(messages: AnyRecord[]) {
  const system: string[] = []
  const rest: AnyRecord[] = []
  for (const message of messages) {
    if (message.role === "system") {
      const text = contentToText(message.content).trim()
      if (text) system.push(text)
    } else {
      rest.push(message)
    }
  }
  return system.length > 0 ? [{ role: "system", content: system.join("\n\n") }, ...rest] : rest
}

const EXTRA_CHAT_PASSTHROUGH_FIELDS = [
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "metadata",
  "n",
  "presence_penalty",
  "response_format",
  "seed",
  "service_tier",
  "stop",
  "stream_options",
  "top_logprobs",
  "user",
]

export function responsesToChatCompletions(body: AnyRecord, target: ProxyTarget) {
  const model = safeTrim(body.model)
  const result: AnyRecord = {}
  if (model) result.model = model

  const toolContext = buildToolContext(body.tools)
  const messages: AnyRecord[] = []
  const instructions = instructionText(body.instructions)
  if (instructions) messages.push({ role: "system", content: instructions })
  appendResponsesInput(body.input, messages)
  normalizeChatMessages(messages)
  appendOutputLanguagePolicyToLatestChatUserMessage(messages, target)
  backfillToolCallReasoningPlaceholders(messages, target)
  result.messages = collapseSystemMessagesToHead(messages)

  const reasoningDialect = resolveReasoningDialect(target)
  const maxOutputTokens = body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens
  if (maxOutputTokens != null) {
    result[isOpenAIOModel(model) ? "max_completion_tokens" : "max_tokens"] = maxOutputTokens
  }
  for (const key of ["temperature", "top_p", "stream"]) {
    if (body[key] != null) result[key] = body[key]
  }
  if (body.stream) {
    result.stream_options = { ...(isObject(body.stream_options) ? body.stream_options : {}), include_usage: true }
  }
  applyChatReasoningOptions(result, body, reasoningDialect, model)

  const responseTools = Array.isArray(body.tools) ? body.tools : []
  const loadedTools = collectToolSearchOutputTools(body.input)
  for (const tool of loadedTools) rememberResponseTool(toolContext, tool)
  const tools = responsesToolsToChatTools([...responseTools, ...loadedTools], toolContext, {
    applyPatchExample: true,
  })
  if (tools.length > 0) {
    result.tools = tools
    const toolChoice = responsesToolChoiceToChat(body.tool_choice, toolContext)
    if (toolChoice != null) result.tool_choice = toolChoice
    if (body.parallel_tool_calls != null) result.parallel_tool_calls = body.parallel_tool_calls
  }

  const allowResponseFormat = supportsChatResponseFormat(target, model)
  const responseFormat = allowResponseFormat
    ? responsesTextFormatToChatResponseFormat(body)
    : undefined
  if (responseFormat) result.response_format = responseFormat

  const hasChatTools = tools.length > 0
  for (const key of EXTRA_CHAT_PASSTHROUGH_FIELDS) {
    if (key === "stream_options" && result.stream_options) continue
    if (key === "response_format" && !allowResponseFormat) continue
    if (key === "response_format" && result.response_format) continue
    if (key === "tool_choice" && (!hasChatTools || isToolChoiceWithNoSurvivingTool(body[key], toolContext))) continue
    if (key === "parallel_tool_calls" && !hasChatTools) continue
    if (body[key] != null) result[key] = body[key]
  }

  if (!hasChatTools) {
    delete result.tool_choice
    delete result.parallel_tool_calls
  }

  return { body: result, toolContext }
}

function splitLeadingThinkBlock(text: string) {
  const trimmedStart = text.trimStart()
  const leading = text.length - trimmedStart.length
  if (!trimmedStart.startsWith("<think>")) return null
  const bodyStart = leading + "<think>".length
  const close = text.indexOf("</think>", bodyStart)
  if (close < 0) return null
  return {
    reasoning: text.slice(bodyStart, close).trim(),
    answer: text.slice(close + "</think>".length).trimStart(),
  }
}

function stripLeadingThinkOpenTag(text: string) {
  const trimmedStart = text.trimStart()
  const leading = text.length - trimmedStart.length
  return trimmedStart.startsWith("<think>")
    ? text.slice(leading + "<think>".length)
    : null
}

type InlineThinkMode = "detecting" | "reasoning" | "text"

function leadingThinkPrefixDecision(buffer: string): "need_more" | "reasoning" | "text" {
  const trimmed = buffer.trimStart()
  if (!trimmed) return "need_more"
  if (trimmed.startsWith("<think>")) return "reasoning"
  if ("<think>".startsWith(trimmed)) return "need_more"
  return "text"
}

function chatReasoningText(message: AnyRecord) {
  const direct = extractChatReasoningText(message)
  if (direct) return direct
  const content = typeof message.content === "string" ? message.content : ""
  return splitLeadingThinkBlock(content)?.reasoning || ""
}

function chatMessageText(message: AnyRecord) {
  if (typeof message.content === "string") {
    const answer = splitLeadingThinkBlock(message.content)?.answer ?? message.content
    return answer || safeTrim(message.refusal)
  }
  return contentToText(message.content) || safeTrim(message.refusal)
}

function chatUsageToResponsesUsage(usage: unknown) {
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
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? 0)
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
  if (cachedTokens > 0) {
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

function responseStatusFromFinishReason(finishReason: unknown) {
  return safeTrim(finishReason) === "length" ? "incomplete" : "completed"
}

function outputTextFromResponseItems(output: AnyRecord[]) {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .join("")
}

function echoOriginalResponseFields(response: AnyRecord, originalRequest: AnyRecord) {
  for (const key of RESPONSE_ECHO_FIELDS) {
    if (originalRequest[key] != null) response[key] = originalRequest[key]
  }
}

export function chatCompletionToResponse(
  payload: unknown,
  originalRequest: AnyRecord,
  serializedContext: SerializedToolContext,
) {
  if (!isObject(payload)) throw new Error("chat response 不是 JSON 对象")
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const choice = choices[0]
  if (!isObject(choice) || !isObject(choice.message)) {
    throw new Error("chat response 缺少 choices[0].message")
  }
  const message = choice.message
  const id = safeTrim(payload.id)
  const respId = id.startsWith("resp_") ? id : `resp_${id || "compat"}`
  const toolContext = deserializeToolContext(serializedContext)
  const output: AnyRecord[] = []

  const reasoning = chatReasoningText(message)
  if (reasoning) {
    output.push({
      id: `rs_${respId}`,
      type: "reasoning",
      reasoning_content: reasoning,
      summary: [{ type: "summary_text", text: reasoning }],
    })
  }
  const text = chatMessageText(message)
  if (text) {
    output.push({
      id: `${respId}_msg`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    })
  }

  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : isObject(message.function_call)
      ? [{ id: message.function_call.id, type: "function", function: message.function_call }]
      : []
  toolCalls.forEach((toolCall: AnyRecord, index: number) => {
    const callId = safeTrim(toolCall.id) || `call_${index}`
    const fn = isObject(toolCall.function) ? toolCall.function : {}
    const name = safeTrim(fn.name)
    if (!name) return
    output.push(toolCallItem(callId, name, responseArgumentsToChat(fn.arguments ?? {}), toolContext, reasoning))
  })

  const response: AnyRecord = {
    id: respId,
    object: "response",
    created_at: Number(payload.created) || Math.floor(Date.now() / 1000),
    status: responseStatusFromFinishReason(choice.finish_reason),
    model: safeTrim(payload.model),
    output,
    output_text: outputTextFromResponseItems(output),
    usage: chatUsageToResponsesUsage(payload.usage),
  }
  applyAssistantMessagePhase(response.output)
  if (response.status === "incomplete") {
    response.incomplete_details = { reason: "max_output_tokens" }
  }
  echoOriginalResponseFields(response, originalRequest)
  return response
}

function chatCompatibleUrl(baseUrl: string, endpoint: "chat/completions" | "models") {
  const rawBase = baseUrl.trim()
  const skipVersionPrefix = rawBase.endsWith("#")
  const base = rawBase.replace(/#+$/, "").replace(/\/+$/, "")
  if (base.toLowerCase().endsWith(`/${endpoint}`)) return base
  if (endpoint === "models" && base.toLowerCase().endsWith("/chat/completions")) {
    return `${base.slice(0, -"/chat/completions".length)}/models`
  }
  if (/\/v\d+(beta)?$/i.test(base)) return `${base}/${endpoint}`
  if (skipVersionPrefix) return `${base}/${endpoint}`
  if (/^https?:\/\/[^/]+$/i.test(base)) return `${base}/v1/${endpoint}`
  return `${base}/${endpoint}`
}

export function buildChatCompatibleRequest(
  target: ProxyTarget,
  path: string,
  body: unknown,
): ChatCompatibleBuiltRequest {
  if (!isObject(body)) throw new Error("请求体必须是 JSON 对象")

  if (isChatCompletionsPath(path)) {
    const passthrough: AnyRecord = target.paused
      ? { ...body }
      : { ...body, model: target.modelId }
    if (!target.paused) {
      applyChatPassthroughReasoningOverride(
        passthrough,
        resolveReasoningDialect(target),
        target.reasoning,
        target.modelId,
      )
    }
    appendOutputLanguagePolicyToChatBody(passthrough, target)
    return {
      url: chatCompatibleUrl(target.provider.baseUrl, "chat/completions"),
      rewrittenBody: passthrough,
      adapter: {
        type: "chat_compatible_passthrough",
        source: "chat_completions",
        requestIsStream: Boolean(passthrough.stream),
        requestedModel: safeTrim(body.model),
        reverseToolNameMap: {},
      },
      init: {
        method: "POST",
        headers: providerHeaders(target.provider, {
          accept: Boolean(passthrough.stream) ? "text/event-stream" : "application/json",
          "content-type": "application/json",
        }),
        body: JSON.stringify(passthrough),
      },
    }
  }

  if (!isResponsesPath(path)) throw new Error(`OpenAI Chat Completions 协议暂不支持：/${path}`)
  const originalRequest: AnyRecord = { ...body }
  const request: AnyRecord = target.paused ? { ...body } : { ...body, model: target.modelId }
  if (!target.paused) {
    setCanonicalReasoning(request, target.reasoning)
  }
  enrichCodexChatRequest(request)
  appendOutputLanguagePolicyToResponsesBody(request, target)
  const converted = responsesToChatCompletions(request, target)
  return {
    url: chatCompatibleUrl(target.provider.baseUrl, "chat/completions"),
    rewrittenBody: converted.body,
    adapter: {
      type: "chat_compatible",
      source: "responses",
      requestIsStream: Boolean(converted.body.stream),
      originalRequest,
      toolContext: serializeToolContext(converted.toolContext),
    },
    init: {
      method: "POST",
      headers: providerHeaders(target.provider, {
        accept: converted.body.stream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      }),
      body: JSON.stringify(converted.body),
    },
  }
}

export function transformChatCompatibleResponse(
  payload: unknown,
  adapter: ChatCompatibleAdapter,
  options: { recordHistory?: boolean } = {},
) {
  if (adapter.type === "chat_compatible_passthrough") return payload
  const response = chatCompletionToResponse(
    payload,
    adapter.originalRequest,
    adapter.toolContext,
  )
  if (options.recordHistory !== false) recordCodexChatResponse(response)
  return response
}

export function chatCompatibleModelsUrl(baseUrl: string) {
  return chatCompatibleUrl(baseUrl, "models")
}

export function chatSseToResponsesSse(
  text: string,
  adapter: Extract<ChatCompatibleAdapter, { type: "chat_compatible" }>,
) {
  const state = createChatSseAccumulator()
  const out = chatSseTextToResponsesSse(
    text,
    adapter.originalRequest,
    adapter.toolContext,
    state,
  )
  return { text: out, responseId: "", usage: null }
}

export function createChatToResponsesSseStream(
  adapter: Extract<ChatCompatibleAdapter, { type: "chat_compatible" }>,
) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const state = createChatSseAccumulator()
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      const boundary = lastCompleteSseFrameBoundary(buffer)
      if (!boundary) return
      const end = boundary.index + boundary.separatorLength
      const head = buffer.slice(0, end)
      buffer = buffer.slice(end)
      const out = chatSseTextToResponsesSse(
        head,
        adapter.originalRequest,
        adapter.toolContext,
        state,
        false,
      )
      if (out) controller.enqueue(encoder.encode(out))
    },
    flush(controller) {
      buffer += decoder.decode()
      const out = chatSseTextToResponsesSse(
        buffer,
        adapter.originalRequest,
        adapter.toolContext,
        state,
        true,
      )
      if (out) controller.enqueue(encoder.encode(out))
    },
  })
}

function parseSseFrames(text: string) {
  return String(text || "")
    .trimStart()
    .replace(/^\uFEFF/, "")
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      let event = ""
      const data: string[] = []
      for (const rawLine of frame.split(/\r?\n/)) {
        const line = rawLine.trimStart()
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
      return { event, payload: data.join("\n") }
    })
    .filter((frame) => frame.payload)
}

function sseErrorMessage(value: unknown) {
  if (typeof value === "string") return value.trim()
  if (!isObject(value)) return ""
  return safeTrim(value.message) || safeTrim(value.detail) || safeTrim(value.error_description)
}

function sse(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

function baseStreamingResponse(state: ChatSseAccum, status: string) {
  return {
    id: state.id,
    object: "response",
    created_at: state.created,
    status,
    model: state.model,
    output: [],
    usage: chatUsageToResponsesUsage(state.usage),
  }
}

function failedChatSse(
  state: ChatSseAccum,
  message: string,
  type = "server_error",
  serializedContext?: SerializedToolContext,
) {
  if (state.completed) return ""
  state.completed = true
  const response: AnyRecord = {
    ...baseStreamingResponse(state, "failed"),
    output: serializedContext ? completedChatSseOutputItems(state, serializedContext) : [],
    error: { message, type },
  }
  return (
    ensureResponseStarted(state) +
    sse("response.failed", {
      type: "response.failed",
      response,
    }) +
    "data: [DONE]\n\n"
  )
}

function ensureResponseStarted(state: ChatSseAccum) {
  if (state.responseStarted) return ""
  state.responseStarted = true
  return (
    sse("response.created", {
      type: "response.created",
      response: baseStreamingResponse(state, "in_progress"),
    }) +
    sse("response.in_progress", {
      type: "response.in_progress",
      response: baseStreamingResponse(state, "in_progress"),
    })
  )
}

function nextStreamingOutputIndex(state: ChatSseAccum) {
  const index = state.nextOutputIndex
  state.nextOutputIndex += 1
  return index
}

interface ChatSseAccum {
  id: string
  created: number
  model: string
  content: string
  reasoning: string
  responseStarted: boolean
  completed: boolean
  nextOutputIndex: number
  messageAdded: boolean
  messageOutputIndex: number | null
  reasoningAdded: boolean
  reasoningOutputIndex: number | null
  reasoningDone: boolean
  inlineThinkMode: InlineThinkMode
  inlineThinkBuffer: string
  toolCalls: Map<
    number,
    {
      id: string
      name: string
      args: string
      itemId: string
      outputIndex: number | null
      reasoningContent: string
    }
  >
  addedToolIndexes: Set<number>
  usage: unknown
  finishReason: string
  sawChoice: boolean
  sawDone: boolean
}

function createChatSseAccumulator(): ChatSseAccum {
  return {
    id: "resp_compat",
    created: Math.floor(Date.now() / 1000),
    model: "",
    content: "",
    reasoning: "",
    responseStarted: false,
    completed: false,
    nextOutputIndex: 0,
    messageAdded: false,
    messageOutputIndex: null,
    reasoningAdded: false,
    reasoningOutputIndex: null,
    reasoningDone: false,
    inlineThinkMode: "detecting",
    inlineThinkBuffer: "",
    toolCalls: new Map(),
    addedToolIndexes: new Set(),
    usage: null,
    finishReason: "",
    sawChoice: false,
    sawDone: false,
  }
}

function hasSubstantiveChatSseOutput(state: ChatSseAccum) {
  if (state.content.trim() || state.reasoning.trim() || state.inlineThinkBuffer.trim()) return true
  if (state.messageAdded || state.reasoningAdded) return true
  for (const toolCall of state.toolCalls.values()) {
    if (
      toolCall.outputIndex != null ||
      toolCall.id.trim() ||
      toolCall.name.trim() ||
      toolCall.args.trim() ||
      toolCall.itemId.trim() ||
      toolCall.reasoningContent.trim()
    ) {
      return true
    }
  }
  return false
}

function appendReasoningToActiveToolCalls(state: ChatSseAccum, reasoning: string) {
  if (!reasoning.trim()) return
  for (const toolCall of state.toolCalls.values()) {
    if (!toolCall.name.trim()) continue
    toolCall.reasoningContent += toolCall.reasoningContent ? reasoning : reasoning.trimStart()
  }
}

function resetChatSseAccumulatedOutput(state: ChatSseAccum) {
  state.content = ""
  state.reasoning = ""
  state.messageAdded = false
  state.messageOutputIndex = null
  state.reasoningAdded = false
  state.reasoningOutputIndex = null
  state.reasoningDone = false
  state.inlineThinkMode = "detecting"
  state.inlineThinkBuffer = ""
  state.toolCalls.clear()
  state.addedToolIndexes.clear()
  state.nextOutputIndex = 0
  state.responseStarted = false
}

function chatToolCallIndex(toolCall: AnyRecord, fallback: number) {
  const raw = Number(toolCall.index ?? fallback)
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : fallback
}

function chatToolArgumentsDelta(value: unknown) {
  if (typeof value === "string") return value
  if (value == null) return ""
  return canonicalJson(value)
}

function mergeChatSseToolCallDelta(
  state: ChatSseAccum,
  rawToolCall: unknown,
  fallbackIndex: number,
  toolContext: ToolContext,
  options: { replaceArguments?: boolean } = {},
) {
  if (!isObject(rawToolCall)) return ""
  let out = ""
  const index = chatToolCallIndex(rawToolCall, fallbackIndex)
  const existing =
    state.toolCalls.get(index) || {
      id: "",
      name: "",
      args: "",
      itemId: "",
      outputIndex: null,
      reasoningContent: state.reasoning.trim(),
    }
  const idDelta = safeTrim(rawToolCall.id)
  if (idDelta && !state.addedToolIndexes.has(index)) existing.id = idDelta
  const fn = isObject(rawToolCall.function) ? rawToolCall.function : rawToolCall
  existing.name ||= safeTrim(fn.name)
  const argumentDelta = chatToolArgumentsDelta(fn.arguments)
  if (argumentDelta) {
    existing.args = options.replaceArguments ? argumentDelta : existing.args + argumentDelta
  }
  let wasAddedNow = false
  if (!state.addedToolIndexes.has(index) && existing.id && existing.name) {
    existing.itemId = toolCallItemId(existing.id, existing.name, toolContext)
    out += ensureResponseStarted(state)
    existing.outputIndex = nextStreamingOutputIndex(state)
    out += sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: existing.outputIndex,
      item: toolCallAddedItem(
        existing.id,
        existing.name,
        toolContext,
        existing.reasoningContent,
      ),
    })
    state.addedToolIndexes.add(index)
    wasAddedNow = true
    if (
      existing.args &&
      !options.replaceArguments &&
      !isCustomToolProxy(existing.name, toolContext) &&
      !toolContext.toolSearchTools.has(existing.name)
    ) {
      out += sse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: existing.itemId,
        output_index: existing.outputIndex,
        delta: existing.args,
      })
    }
  }
  if (
    argumentDelta &&
    !wasAddedNow &&
    !options.replaceArguments &&
    state.addedToolIndexes.has(index) &&
    existing.outputIndex != null &&
    existing.itemId &&
    !isCustomToolProxy(existing.name, toolContext) &&
    !toolContext.toolSearchTools.has(existing.name)
  ) {
    out += sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: existing.itemId,
      output_index: existing.outputIndex,
      delta: argumentDelta,
    })
  }
  state.toolCalls.set(index, existing)
  return out
}

function applyChatSseFullMessageSnapshot(
  state: ChatSseAccum,
  payload: AnyRecord,
  serializedContext: SerializedToolContext,
) {
  let out = ""
  const reasoning = extractChatReasoningText(payload)
  if (reasoning) {
    if (state.reasoningAdded) state.reasoning = reasoning
    else out += pushChatSseReasoningDelta(state, reasoning)
  }

  const content = chatPayloadContentText(payload.content) || safeTrim(payload.refusal)
  if (content) {
    if (state.messageAdded) state.content = content
    else out += pushChatSseContentDelta(state, content)
  }

  const toolContext = deserializeToolContext(serializedContext)
  const toolCalls = Array.isArray(payload.tool_calls)
    ? payload.tool_calls
    : isObject(payload.function_call)
      ? [{ index: 0, id: payload.function_call.id, type: "function", function: payload.function_call }]
      : []
  if (toolCalls.length > 0) {
    out += flushChatSseInlineThinkAtBoundary(state)
    out += finalizeChatSseReasoning(state)
    for (const [position, toolCall] of toolCalls.entries()) {
      out += mergeChatSseToolCallDelta(state, toolCall, position, toolContext, {
        replaceArguments: true,
      })
    }
  }
  return out
}

function pushChatSseReasoningDelta(state: ChatSseAccum, reasoning: string) {
  if (!reasoning) return ""
  let out = ensureResponseStarted(state)
  if (!state.reasoningAdded) {
    state.reasoningOutputIndex = nextStreamingOutputIndex(state)
    out += sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.reasoningOutputIndex,
      item: {
        id: `rs_${state.id}`,
        type: "reasoning",
        status: "in_progress",
        reasoning_content: "",
        summary: [],
      },
    })
    out += sse("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: `rs_${state.id}`,
      output_index: state.reasoningOutputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    })
    state.reasoningAdded = true
    state.reasoningDone = false
  }
  state.reasoning += reasoning
  appendReasoningToActiveToolCalls(state, reasoning)
  out += sse("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: `rs_${state.id}`,
    output_index: state.reasoningOutputIndex ?? 0,
    summary_index: 0,
    delta: reasoning,
  })
  return out
}

function finalizeChatSseReasoning(state: ChatSseAccum) {
  if (!state.reasoningAdded || state.reasoningDone) return ""
  state.reasoningDone = true
  return (
    sse("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: `rs_${state.id}`,
      output_index: state.reasoningOutputIndex ?? 0,
      summary_index: 0,
      text: state.reasoning,
    }) +
    sse("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: `rs_${state.id}`,
      output_index: state.reasoningOutputIndex ?? 0,
      summary_index: 0,
      part: { type: "summary_text", text: state.reasoning },
    }) +
    sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningOutputIndex ?? 0,
      item: {
        id: `rs_${state.id}`,
        type: "reasoning",
        status: "completed",
        reasoning_content: state.reasoning,
        summary: [{ type: "summary_text", text: state.reasoning }],
      },
    })
  )
}

function pushChatSseTextDelta(state: ChatSseAccum, content: string) {
  if (!content) return ""
  let out = finalizeChatSseReasoning(state)
  out += ensureResponseStarted(state)
  if (!state.messageAdded) {
    state.messageOutputIndex = nextStreamingOutputIndex(state)
    out += sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.messageOutputIndex,
      item: {
        id: `${state.id}_msg`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    })
    out += sse("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `${state.id}_msg`,
      output_index: state.messageOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })
    state.messageAdded = true
  }
  state.content += content
  out += sse("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `${state.id}_msg`,
    output_index: state.messageOutputIndex ?? 0,
    content_index: 0,
    delta: content,
  })
  return out
}

function drainCompleteInlineThink(state: ChatSseAccum) {
  const split = splitLeadingThinkBlock(state.inlineThinkBuffer)
  if (!split) return ""
  state.inlineThinkMode = "text"
  state.inlineThinkBuffer = ""
  let out = ""
  if (split.reasoning) {
    out += pushChatSseReasoningDelta(state, split.reasoning)
    out += finalizeChatSseReasoning(state)
  }
  if (split.answer) out += pushChatSseTextDelta(state, split.answer)
  return out
}

function flushChatSseInlineThinkAtBoundary(state: ChatSseAccum) {
  if (state.inlineThinkMode === "text") return ""
  const buffered = state.inlineThinkBuffer
  state.inlineThinkBuffer = ""
  if (state.inlineThinkMode === "detecting") {
    state.inlineThinkMode = "text"
    return buffered ? pushChatSseTextDelta(state, buffered) : ""
  }

  state.inlineThinkMode = "text"
  const split = splitLeadingThinkBlock(buffered)
  if (split) {
    let out = ""
    if (split.reasoning) {
      out += pushChatSseReasoningDelta(state, split.reasoning)
      out += finalizeChatSseReasoning(state)
    }
    if (split.answer) out += pushChatSseTextDelta(state, split.answer)
    return out
  }
  const reasoning = stripLeadingThinkOpenTag(buffered) ?? buffered
  return reasoning ? pushChatSseReasoningDelta(state, reasoning) + finalizeChatSseReasoning(state) : ""
}

function pushChatSseContentDelta(state: ChatSseAccum, content: string) {
  if (!content) return ""
  if (state.inlineThinkMode === "text") return pushChatSseTextDelta(state, content)
  state.inlineThinkBuffer += content

  if (state.inlineThinkMode === "detecting") {
    const decision = leadingThinkPrefixDecision(state.inlineThinkBuffer)
    if (decision === "need_more") return ""
    if (decision === "text") {
      state.inlineThinkMode = "text"
      const text = state.inlineThinkBuffer
      state.inlineThinkBuffer = ""
      return pushChatSseTextDelta(state, text)
    }
    state.inlineThinkMode = "reasoning"
  }

  return drainCompleteInlineThink(state)
}

function completedChatSseOutputItems(state: ChatSseAccum, serializedContext: SerializedToolContext) {
  const output: Array<{ index: number; item: AnyRecord }> = []
  if (state.reasoningAdded && state.reasoningDone) {
    output.push({
      index: state.reasoningOutputIndex ?? 0,
      item: {
        id: `rs_${state.id}`,
        type: "reasoning",
        status: "completed",
        reasoning_content: state.reasoning,
        summary: [{ type: "summary_text", text: state.reasoning }],
      },
    })
  }
  if (state.messageAdded) {
    output.push({
      index: state.messageOutputIndex ?? 0,
      item: {
        id: `${state.id}_msg`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: state.content, annotations: [] }],
      },
    })
  }
  const toolContext = deserializeToolContext(serializedContext)
  for (const toolCall of state.toolCalls.values()) {
    if (!toolCall.name || toolCall.outputIndex == null) continue
    const argumentsText = canonicalToolArgumentsString(toolCall.args)
    output.push({
      index: toolCall.outputIndex,
      item: toolCallItem(
        toolCall.id,
        toolCall.name,
        argumentsText,
        toolContext,
        toolCall.reasoningContent,
      ),
    })
  }
  const items = output.sort((a, b) => a.index - b.index).map((entry) => entry.item)
  applyAssistantMessagePhase(items)
  return items
}

function finalizeChatSseAfterStreamEnd(
  originalRequest: AnyRecord,
  serializedContext: SerializedToolContext,
  state: ChatSseAccum,
) {
  if (state.completed || state.finishReason) {
    return finalizeChatSse(originalRequest, serializedContext, state)
  }
  if (state.sawDone) {
    return finalizeChatSse(originalRequest, serializedContext, state)
  }
  if (hasSubstantiveChatSseOutput(state)) {
    state.finishReason = "length"
    return finalizeChatSse(originalRequest, serializedContext, state)
  }
  return failedChatSse(
    state,
    "Upstream Chat Completions stream ended before sending finish_reason",
    "stream_truncated",
    serializedContext,
  )
}

function chatSseTextToResponsesSse(
  text: string,
  originalRequest: AnyRecord,
  serializedContext: SerializedToolContext,
  state: ChatSseAccum,
  flushTail = true,
) {
  let out = ""
  for (const frame of parseSseFrames(text)) {
    if (frame.payload === "[DONE]") {
      state.sawDone = true
      if (!state.sawChoice && !hasSubstantiveChatSseOutput(state)) {
        out += failedChatSse(
          state,
          "Upstream Chat Completions stream ended without any choices",
          "stream_truncated",
          serializedContext,
        )
        continue
      }
      out += finalizeChatSse(
        originalRequest,
        serializedContext,
        state,
      )
      continue
    }
    let chunk: AnyRecord
    try {
      chunk = JSON.parse(frame.payload)
    } catch {
      continue
    }
    const explicitErrorMessage =
      frame.event === "error"
        ? sseErrorMessage(isObject(chunk.error) ? chunk.error : chunk)
        : sseErrorMessage(chunk.error)
    if (explicitErrorMessage) {
      const error = isObject(chunk.error) ? chunk.error : chunk
      out += failedChatSse(
        state,
        explicitErrorMessage,
        error.type || error.code || "server_error",
        serializedContext,
      )
      return out
    }
    const chunkId = safeTrim(chunk.id)
    if (chunkId) state.id = chunkId.startsWith("resp_") ? chunkId : `resp_${chunkId}`
    state.model = safeTrim(chunk.model) || state.model
    state.created = Number(chunk.created) || state.created
    if (chunk.usage) state.usage = chunk.usage
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const choice = choices.find((entry) => isObject(entry) && Number(entry.index ?? 0) === 0) ?? choices[0]
    if (!isObject(choice)) continue
    state.sawChoice = true
    const deltaObject = isObject(choice.delta) ? choice.delta : null
    const messageObject = isObject(choice.message) ? choice.message : null
    const deltaHasPayload = Boolean(deltaObject && Object.keys(deltaObject).length > 0)
    const payload: AnyRecord = deltaHasPayload && deltaObject ? deltaObject : messageObject || deltaObject || {}
    const isFullMessage = Boolean(!deltaHasPayload && messageObject)
    if (isFullMessage && state.responseStarted) {
      out += applyChatSseFullMessageSnapshot(state, payload, serializedContext)
      if (!state.finishReason && choice.finish_reason) state.finishReason = safeTrim(choice.finish_reason)
      continue
    }
    if (isFullMessage) resetChatSseAccumulatedOutput(state)
    const reasoning = extractChatReasoningText(payload)
    if (reasoning) {
      out += pushChatSseReasoningDelta(state, reasoning)
    }
    const content = chatPayloadContentText(payload.content) || safeTrim(payload.refusal)
    if (content) {
      out += pushChatSseContentDelta(state, content)
    }
    if (Array.isArray(payload.tool_calls)) {
      out += flushChatSseInlineThinkAtBoundary(state)
      out += finalizeChatSseReasoning(state)
      const toolContext = deserializeToolContext(serializedContext)
      for (const [position, toolCall] of payload.tool_calls.entries()) {
        out += mergeChatSseToolCallDelta(state, toolCall, position, toolContext)
      }
    } else if (isObject(payload.function_call)) {
      out += flushChatSseInlineThinkAtBoundary(state)
      out += finalizeChatSseReasoning(state)
      const toolContext = deserializeToolContext(serializedContext)
      out += mergeChatSseToolCallDelta(
        state,
        { index: 0, id: payload.function_call.id, type: "function", function: payload.function_call },
        0,
        toolContext,
      )
    }
    if (!state.finishReason && choice.finish_reason) state.finishReason = safeTrim(choice.finish_reason)
  }

  return flushTail
    ? out + finalizeChatSseAfterStreamEnd(originalRequest, serializedContext, state)
    : out
}

function finalizeChatSse(
  originalRequest: AnyRecord,
  serializedContext: SerializedToolContext,
  state: ChatSseAccum,
) {
  if (state.completed) return ""
  let out = ensureResponseStarted(state)
  out += flushChatSseInlineThinkAtBoundary(state)
  out += finalizeChatSseReasoning(state)
  const hasVisibleMessage = state.messageAdded && state.content.trim().length > 0
  const hasToolCall = Array.from(state.toolCalls.values()).some((toolCall) =>
    toolCall.name.trim().length > 0,
  )
  if (!hasVisibleMessage && !hasToolCall) {
    return out + failedChatSse(
      state,
      state.reasoning.trim()
        ? "上游 Chat 流式响应只返回了 reasoning_content，没有返回可见消息或工具调用"
        : "上游 Chat 流式响应没有返回可见消息或工具调用",
      "empty_visible_output",
      serializedContext,
    )
  }
  state.completed = true
  if (state.messageAdded) {
    // message 的 output_item.done 在此处（收尾）才发出，此时工具调用已全部累积完，
    // 可直接判定 phase：后面还有工具调用则该 message 是回合中途叙述（commentary），
    // 否则是回合最终答案（final_answer）。带上 phase，桌面端收到 done 帧即可正确折叠，
    // 无需等 response.completed 再手动点一下。
    const messagePhase = state.toolCalls.size > 0 ? "commentary" : "final_answer"
    out += sse("response.output_text.done", {
      type: "response.output_text.done",
      item_id: `${state.id}_msg`,
      output_index: state.messageOutputIndex ?? 0,
      content_index: 0,
      text: state.content,
    })
    out += sse("response.content_part.done", {
      type: "response.content_part.done",
      item_id: `${state.id}_msg`,
      output_index: state.messageOutputIndex ?? 0,
      content_index: 0,
      part: { type: "output_text", text: state.content, annotations: [] },
    })
    out += sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.messageOutputIndex ?? 0,
      item: {
        id: `${state.id}_msg`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: state.content, annotations: [] }],
        phase: messagePhase,
      },
    })
  }
  if (state.toolCalls.size > 0) {
    const toolContext = deserializeToolContext(serializedContext)
    for (const [index, toolCall] of state.toolCalls) {
      if (!toolCall.name) continue
      if (!toolCall.id) toolCall.id = `call_${index}`
      if (toolCall.outputIndex == null) {
        toolCall.outputIndex = nextStreamingOutputIndex(state)
        toolCall.itemId = toolCallItemId(toolCall.id, toolCall.name, toolContext)
        out += sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: toolCall.outputIndex,
          item: toolCallAddedItem(
            toolCall.id,
            toolCall.name,
            toolContext,
            toolCall.reasoningContent,
          ),
        })
        state.addedToolIndexes.add(index)
      }
      const outputIndex = toolCall.outputIndex
      const itemId = toolCall.itemId || toolCallItemId(toolCall.id, toolCall.name, toolContext)
      const argumentsText = canonicalToolArgumentsString(toolCall.args)
      const item = toolCallItem(
        toolCall.id,
        toolCall.name,
        argumentsText,
        toolContext,
        toolCall.reasoningContent,
      )
      if (isCustomToolProxy(toolCall.name, toolContext)) {
        const input = item.input || ""
        out += sse("response.custom_tool_call_input.delta", {
          type: "response.custom_tool_call_input.delta",
          item_id: itemId,
          call_id: toolCall.id,
          output_index: outputIndex,
          delta: input,
        })
        out += sse("response.custom_tool_call_input.done", {
          type: "response.custom_tool_call_input.done",
          item_id: itemId,
          call_id: toolCall.id,
          output_index: outputIndex,
          input,
        })
      } else if (!toolContext.toolSearchTools.has(toolCall.name)) {
        out += sse("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: itemId,
          output_index: outputIndex,
          arguments: argumentsText,
        })
      }
      out += sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      })
    }
  }

  const output = completedChatSseOutputItems(state, serializedContext)
  const status = responseStatusFromFinishReason(state.finishReason || "stop")
  const response: AnyRecord = {
    id: state.id,
    object: "response",
    created_at: state.created,
    status,
    model: state.model,
    output,
    output_text: outputTextFromResponseItems(output),
    usage: chatUsageToResponsesUsage(state.usage),
  }
  if (status === "incomplete") {
    response.incomplete_details = { reason: "max_output_tokens" }
  }
  echoOriginalResponseFields(response, originalRequest)
  recordCodexChatResponse(response)
  out += sse("response.completed", { type: "response.completed", response })
  out += "data: [DONE]\n\n"
  return out
}

export {
  buildChatCompletionPayload,
  createChatCompletionsSseStream,
  extractFinalResponseFromSse,
  extractOutputText,
  responsesSseToChatCompletionsSse,
  transformResponsesSseText,
}
