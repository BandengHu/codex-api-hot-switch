import "server-only"

import type { ReasoningEffort } from "@/lib/types"
import type { AnthropicThinkingBlock } from "./anthropic-thinking"
import {
  joinUrl,
  providerHeaders,
  type ProxyTarget,
} from "./common"
import {
  buildNativeCanonicalRequest,
  nativeAdapter,
  type CanonicalContentPart,
  type CanonicalInputItem,
  type CanonicalResponseFormat,
  type NativeAdapter,
  type NativeCanonicalRequest,
} from "./native-canonical"
import {
  buildOpenAIChatFromNativeResponse,
  buildOpenAIResponseFromNative,
  openAIUsageFromAnthropic,
  type NativeOutputItem,
} from "./native-openai"

type AnyRecord = Record<string, any>

const MIN_THINKING_BUDGET_TOKENS = 1024
const ANTHROPIC_MAX_PROMPT_CACHE_BREAKPOINTS = 4
const ANTHROPIC_PROMPT_CACHE_BREAKPOINTS_TO_ADD = 3
const ANTHROPIC_THINKING_PLACEHOLDER = "tool call"
const ANTHROPIC_REDACTED_THINKING_PLACEHOLDER = "[redacted thinking]"
const REASONING_VENDOR_HINTS = ["moonshot", "kimi", "deepseek", "mimo", "xiaomimimo"]

export interface AnthropicBuiltRequest {
  url: string
  init: RequestInit
  rewrittenBody: unknown
  adapter: NativeAdapter
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function thinkingBudget(reasoning: ReasoningEffort) {
  if (reasoning === "minimal") return 1024
  if (reasoning === "low") return 2048
  if (reasoning === "medium") return 8192
  if (reasoning === "high") return 16000
  if (reasoning === "xhigh" || reasoning === "max") return 32000
  if (reasoning === "auto") return 4096
  return 0
}

function supportsAdaptiveThinking(modelId: string) {
  return (
    /(?:claude-)?(?:opus-4-(?:6|7|8)|sonnet-4-6)(?:\b|-)/i.test(modelId)
  )
}

function hasAlwaysOnAdaptiveThinking(modelId: string) {
  return /(?:claude-)?(?:fable-5|mythos-5|mythos-preview)(?:\b|-)/i.test(modelId)
}

function supportsAdaptiveXHigh(modelId: string) {
  return (
    /(?:claude-)?(?:fable|mythos)-5(?:\b|-)/i.test(modelId) ||
    /(?:claude-)?opus-4-(?:7|8)(?:\b|-)/i.test(modelId)
  )
}

function adaptiveThinkingEffort(modelId: string, reasoning: ReasoningEffort) {
  if (reasoning === "minimal" || reasoning === "low") return "low"
  if (reasoning === "medium") return "medium"
  if (reasoning === "high") return "high"
  if (reasoning === "xhigh" || reasoning === "max") return supportsAdaptiveXHigh(modelId) ? "xhigh" : "max"
  return undefined
}

function summarizedAdaptiveThinking() {
  return { type: "adaptive", display: "summarized" }
}

function summarizedBudgetThinking(budgetTokens: number) {
  return { type: "enabled", budget_tokens: budgetTokens, display: "summarized" }
}

function maxTokensWithThinkingHeadroom(
  reasoning: ReasoningEffort,
  visibleOutputTokens: number,
) {
  const budget = thinkingBudget(reasoning)
  return budget > 0 ? visibleOutputTokens + budget : visibleOutputTokens
}

function anthropicThinkingConfig(
  modelId: string,
  reasoning: ReasoningEffort,
  maxOutputTokens: number,
  target: ProxyTarget,
) {
  if (reasoning === "off" && shouldSendExplicitThinkingDisabled(target, modelId)) {
    return { maxTokens: maxOutputTokens, thinking: { type: "disabled" } }
  }

  if (hasAlwaysOnAdaptiveThinking(modelId)) {
    const effort = adaptiveThinkingEffort(modelId, reasoning)
    return {
      maxTokens: maxTokensWithThinkingHeadroom(reasoning, maxOutputTokens),
      thinking: reasoning === "off" ? undefined : summarizedAdaptiveThinking(),
      outputConfig: effort ? { effort } : undefined,
    }
  }

  if (supportsAdaptiveThinking(modelId)) {
    if (reasoning === "off") return { maxTokens: maxOutputTokens, thinking: undefined }
    if (reasoning === "auto") {
      return {
        maxTokens: maxTokensWithThinkingHeadroom(reasoning, maxOutputTokens),
        thinking: summarizedAdaptiveThinking(),
        outputConfig: undefined,
      }
    }
    return {
      maxTokens: maxTokensWithThinkingHeadroom(reasoning, maxOutputTokens),
      thinking: summarizedAdaptiveThinking(),
      outputConfig: { effort: adaptiveThinkingEffort(modelId, reasoning) },
    }
  }

  const requestedBudget = thinkingBudget(reasoning)
  if (requestedBudget <= 0) {
    return { maxTokens: maxOutputTokens, thinking: undefined }
  }

  const visibleOutputTokens = Math.max(1, maxOutputTokens)
  const budget = Math.max(MIN_THINKING_BUDGET_TOKENS, requestedBudget)
  return {
    maxTokens: budget + visibleOutputTokens,
    thinking: summarizedBudgetThinking(budget),
  }
}

function isDeepSeekAnthropicTarget(target: ProxyTarget, modelId: string) {
  const hint = `${target.provider.name} ${target.provider.baseUrl} ${target.provider.protocol} ${modelId}`.toLowerCase()
  return hint.includes("deepseek")
}

function shouldSendExplicitThinkingDisabled(target: ProxyTarget, modelId: string) {
  return isDeepSeekAnthropicTarget(target, modelId)
}

function dataUrlParts(url: string) {
  const match = url.match(/^data:([^;,]+);base64,([\s\S]+)$/)
  if (!match) return null
  return { mediaType: match[1], data: match[2] }
}

function isOpenAIFileId(value: string) {
  return /^file-[A-Za-z0-9_-]+$/.test(value.trim())
}

function isReasoningVendorIdentifier(value: unknown) {
  const text = typeof value === "string" ? value.toLowerCase() : ""
  return REASONING_VENDOR_HINTS.some((hint) => text.includes(hint))
}

function contentPartToAnthropic(part: CanonicalContentPart) {
  if (part.type === "text") return { type: "text", text: part.text }
  if (part.type === "image") {
    const dataUrl = dataUrlParts(part.url)
    if (dataUrl) {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: dataUrl.mediaType,
          data: dataUrl.data,
        },
      }
    }
    return {
      type: "image",
      source: { type: "url", url: part.url },
    }
  }
  if (isOpenAIFileId(part.fileData)) {
    return {
      type: "document",
      source: { type: "file", file_id: part.fileData },
    }
  }
  throw new Error(
    `Anthropic 原生协议只支持 file_id 或图片输入${part.filename ? `：${part.filename}` : ""}`,
  )
}

function contentPartToAnthropicToolResult(part: CanonicalContentPart) {
  if (part.type === "file") {
    if (isOpenAIFileId(part.fileData)) {
      return {
        type: "document",
        source: { type: "file", file_id: part.fileData },
      }
    }
    return {
      type: "text",
      text: `[Unsupported file${part.filename ? `: ${part.filename}` : ""}]`,
    }
  }
  return contentPartToAnthropic(part)
}

function mergeAdjacentTextBlocks(blocks: AnyRecord[]) {
  const merged: AnyRecord[] = []
  for (const block of blocks) {
    const previous = merged.at(-1)
    if (block.type === "text" && previous?.type === "text") {
      previous.text = `${previous.text || ""}${block.text || ""}`
    } else {
      merged.push(block)
    }
  }
  return merged
}

function flushMessage(messages: AnyRecord[], role: "user" | "assistant", blocks: AnyRecord[]) {
  if (blocks.length === 0) return
  const last = messages.at(-1)
  if (last?.role === role && Array.isArray(last.content)) {
    last.content = mergeAdjacentTextBlocks([...last.content, ...blocks])
  } else {
    messages.push({ role, content: mergeAdjacentTextBlocks(blocks) })
  }
}

function toolResultText(block: AnyRecord) {
  const content = block.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (isObject(part) && typeof part.text === "string") return part.text
        if (isObject(part) && part.type === "image") return "[Image tool result]"
        return JSON.stringify(part)
      })
      .filter(Boolean)
      .join("\n")
  }
  return JSON.stringify(content ?? "")
}

function sanitizeAnthropicToolResults(messages: AnyRecord[]) {
  const sanitized: AnyRecord[] = []
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : []
    if (message.role !== "user" || content.length === 0) {
      sanitized.push(message)
      continue
    }

    const previous = sanitized.at(-1)
    const validToolIds = new Set<string>()
    if (previous?.role === "assistant" && Array.isArray(previous.content)) {
      for (const block of previous.content) {
        if (isObject(block) && block.type === "tool_use" && typeof block.id === "string") {
          validToolIds.add(block.id)
        }
      }
    }

    const nextContent: AnyRecord[] = []
    const orphaned: AnyRecord[] = []
    for (const block of content) {
      if (
        isObject(block) &&
        block.type === "tool_result" &&
        !validToolIds.has(String(block.tool_use_id || ""))
      ) {
        orphaned.push(block)
      } else {
        nextContent.push(block)
      }
    }

    if (orphaned.length > 0) {
      nextContent.unshift({
        type: "text",
        text: [
          "[Previous tool results from compacted history]",
          ...orphaned.map((block) => {
            const id = String(block.tool_use_id || "unknown")
            const text = toolResultText(block).slice(0, 1000)
            return `- Tool ${id}: ${text}`
          }),
        ].join("\n"),
      })
    }

    if (nextContent.length > 0) {
      sanitized.push({ ...message, content: mergeAdjacentTextBlocks(nextContent) })
    }
  }
  return sanitized
}

function canonicalInputToAnthropicMessages(input: CanonicalInputItem[]) {
  const messages: AnyRecord[] = []
  let currentRole: "user" | "assistant" | null = null
  let currentBlocks: AnyRecord[] = []

  const flush = () => {
    if (!currentRole) return
    flushMessage(messages, currentRole, currentBlocks)
    currentRole = null
    currentBlocks = []
  }

  for (const item of input) {
    if (item.type === "message") {
      if (currentRole !== item.role) flush()
      currentRole = item.role
      currentBlocks.push(...item.content.map(contentPartToAnthropic))
      continue
    }
    if (item.type === "thinking") {
      if (currentRole !== "assistant") flush()
      currentRole = "assistant"
      currentBlocks.push(...item.blocks)
      continue
    }
    if (item.type === "function_call") {
      if (currentRole !== "assistant") flush()
      currentRole = "assistant"
      currentBlocks.push({
        type: "tool_use",
        id: item.callId,
        name: item.name,
        input: item.argumentsObject,
      })
      continue
    }
    flush()
    const content =
      item.outputContent && item.outputContent.length > 0
        ? item.outputContent.map(contentPartToAnthropicToolResult)
        : item.output
    flushMessage(messages, "user", [
      {
        type: "tool_result",
        tool_use_id: item.callId,
        content,
      },
    ])
  }

  flush()
  const sanitized = sanitizeAnthropicToolResults(messages)
  return sanitized.length > 0
    ? sanitized
    : [{ role: "user", content: [{ type: "text", text: "" }] }]
}

function anthropicToolChoice(canonical: NativeCanonicalRequest) {
  const choice = canonical.toolChoice
  if (!choice) return undefined
  if (choice.type === "none") return undefined
  if (choice.type === "auto") return { type: "auto" }
  if (choice.type === "any") return { type: "any" }
  return { type: "tool", name: choice.name }
}

function applyParallelToolChoice(body: AnyRecord, canonical: NativeCanonicalRequest) {
  if (canonical.parallelToolCalls !== false || !body.tool_choice) return
  body.tool_choice = {
    ...body.tool_choice,
    disable_parallel_tool_use: true,
  }
}

function stripThinkingForForcedToolChoice(body: AnyRecord) {
  const choiceType = body.tool_choice?.type
  if (choiceType === "any" || choiceType === "tool") {
    const thinkingType = safeTrim(body.thinking?.type)
    if (thinkingType !== "disabled") delete body.thinking
    if (isObject(body.output_config)) {
      delete body.output_config.effort
      if (Object.keys(body.output_config).length === 0) {
        delete body.output_config
      }
    }
  }
}

function applyResponseFormat(body: AnyRecord, format: CanonicalResponseFormat | undefined) {
  if (!format) return
  if (format.type === "json_object") {
    const hint = {
      type: "text",
      text: "Respond with valid JSON only. Do not include any text outside the JSON object.",
    }
    body.system = Array.isArray(body.system)
      ? [hint, ...body.system]
      : body.system
        ? [hint, { type: "text", text: String(body.system) }]
        : [hint]
    return
  }

  body.output_config = {
    ...(isObject(body.output_config) ? body.output_config : {}),
    format: {
      type: "json_schema",
      schema: format.schema,
      ...(format.name ? { name: format.name } : {}),
      ...(format.strict != null ? { strict: format.strict } : {}),
    },
  }
}

function hasToolResultWithoutPreservedThinking(messages: AnyRecord[]) {
  for (let index = 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== "user" || !Array.isArray(message.content)) continue
    const hasToolResult = message.content.some(
      (block: unknown) => isObject(block) && block.type === "tool_result",
    )
    if (!hasToolResult) continue

    const previous = messages[index - 1]
    if (previous?.role !== "assistant" || !Array.isArray(previous.content)) continue
    const hasToolUse = previous.content.some(
      (block: unknown) => isObject(block) && block.type === "tool_use",
    )
    const hasThinking = previous.content.some(
      (block: unknown) =>
        isObject(block) &&
        (block.type === "thinking" || block.type === "redacted_thinking"),
    )
    if (hasToolUse && !hasThinking) return true
  }
  return false
}

function normalizeAnthropicToolThinkingHistoryForProvider(body: AnyRecord, target: ProxyTarget) {
  const providerHint = `${target.provider.name} ${target.provider.baseUrl} ${target.provider.protocol}`
  if (!isReasoningVendorIdentifier(body.model) && !isReasoningVendorIdentifier(providerHint)) return
  if (!Array.isArray(body.messages)) return

  for (const message of body.messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
    const hasToolUse = message.content.some(
      (block: unknown) => isObject(block) && block.type === "tool_use",
    )
    if (!hasToolUse) continue

    let hasThinking = false
    for (let index = 0; index < message.content.length; index += 1) {
      const block = message.content[index]
      if (!isObject(block)) continue
      if (block.type === "thinking") {
        hasThinking = true
        delete block.signature
        if (!safeTrim(block.thinking)) block.thinking = ANTHROPIC_THINKING_PLACEHOLDER
      } else if (block.type === "redacted_thinking") {
        hasThinking = true
        message.content[index] = {
          type: "thinking",
          thinking: ANTHROPIC_REDACTED_THINKING_PLACEHOLDER,
        }
      }
    }

    if (!hasThinking) {
      message.content.unshift({
        type: "thinking",
        thinking: ANTHROPIC_THINKING_PLACEHOLDER,
      })
    }
  }
}

function disableThinkingForIncompatibleToolContinuation(body: AnyRecord) {
  if (!body.thinking || !Array.isArray(body.messages)) return
  if (!hasToolResultWithoutPreservedThinking(body.messages)) return
  delete body.thinking
  if (isObject(body.output_config)) {
    delete body.output_config.effort
    if (Object.keys(body.output_config).length === 0) {
      delete body.output_config
    }
  }
}

function isClaudeAnthropicBody(body: AnyRecord) {
  return safeTrim(body.model).toLowerCase().includes("claude")
}

function countPromptCacheBreakpoints(value: unknown, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== "object") return 0
  if (seen.has(value)) return 0
  seen.add(value)

  let count = isObject(value) && value.cache_control != null ? 1 : 0
  for (const child of Object.values(value)) {
    count += countPromptCacheBreakpoints(child, seen)
  }
  return count
}

function lastCacheableBlock(blocks: unknown) {
  if (!Array.isArray(blocks)) return null
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (!isObject(block)) continue
    const type = safeTrim(block.type)
    if (type === "thinking" || type === "redacted_thinking") continue
    return block
  }
  return null
}

function setPromptCacheBreakpoint(block: AnyRecord | null, consume: () => boolean) {
  if (!block || block.cache_control != null || !consume()) return false
  block.cache_control = { type: "ephemeral" }
  return true
}

function applyAnthropicPromptCaching(body: AnyRecord) {
  if (!isClaudeAnthropicBody(body)) return

  let remaining = Math.min(
    ANTHROPIC_PROMPT_CACHE_BREAKPOINTS_TO_ADD,
    ANTHROPIC_MAX_PROMPT_CACHE_BREAKPOINTS - countPromptCacheBreakpoints(body),
  )
  if (remaining <= 0) return

  const consume = () => {
    if (remaining <= 0) return false
    remaining -= 1
    return true
  }

  setPromptCacheBreakpoint(lastCacheableBlock(body.system), consume)

  if (!Array.isArray(body.messages)) return
  let messageBreakpoints = 0
  for (
    let index = body.messages.length - 1;
    index >= 0 && remaining > 0 && messageBreakpoints < 2;
    index -= 1
  ) {
    const message = body.messages[index]
    if (!isObject(message)) continue
    const added = setPromptCacheBreakpoint(lastCacheableBlock(message.content), consume)
    if (added) messageBreakpoints += 1
  }
}

function buildAnthropicBody(canonical: NativeCanonicalRequest, target: ProxyTarget) {
  const thinking = anthropicThinkingConfig(
    canonical.modelId,
    canonical.reasoning,
    canonical.maxOutputTokens,
    target,
  )
  const body: AnyRecord = {
    model: canonical.modelId,
    messages: canonicalInputToAnthropicMessages(canonical.input),
    max_tokens: thinking.maxTokens,
    stream: canonical.requestIsStream,
  }

  if (canonical.instructions) {
    body.system = [{ type: "text", text: canonical.instructions }]
  }
  if (canonical.temperature != null) body.temperature = canonical.temperature
  if (canonical.topP != null) body.top_p = canonical.topP
  if (canonical.topK != null) body.top_k = canonical.topK
  if (canonical.stopSequences.length > 0) body.stop_sequences = canonical.stopSequences
  if (canonical.tools.length > 0) {
    body.tools = canonical.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }
  const toolChoice = anthropicToolChoice(canonical)
  if (toolChoice) body.tool_choice = toolChoice

  if (thinking.thinking) {
    body.thinking = thinking.thinking
  }
  if (thinking.outputConfig) {
    body.output_config = {
      ...(isObject(body.output_config) ? body.output_config : {}),
      ...thinking.outputConfig,
    }
  }

  applyResponseFormat(body, canonical.responseFormat)
  applyParallelToolChoice(body, canonical)
  stripThinkingForForcedToolChoice(body)
  normalizeAnthropicToolThinkingHistoryForProvider(body, target)
  disableThinkingForIncompatibleToolContinuation(body)

  applyAnthropicPromptCaching(body)

  return body
}

export function buildAnthropicRequest(
  target: ProxyTarget,
  path: string,
  body: unknown,
): AnthropicBuiltRequest {
  const canonical = buildNativeCanonicalRequest(target, path, body)
  const rewrittenBody = buildAnthropicBody(canonical, target)

  return {
    url: joinUrl(target.provider.baseUrl, "messages"),
    rewrittenBody,
    adapter: nativeAdapter("anthropic", canonical),
    init: {
      method: "POST",
      headers: providerHeaders(target.provider, {
        accept: canonical.requestIsStream ? "text/event-stream" : "application/json",
        "content-type": "application/json",
      }),
      body: JSON.stringify(rewrittenBody),
    },
  }
}

function argumentsTextFromObject(value: unknown) {
  if (value == null) return "{}"
  if (typeof value === "string") {
    try {
      JSON.parse(value)
      return value
    } catch {
      return JSON.stringify({ input: value })
    }
  }
  return JSON.stringify(value)
}

function outputItemsFromAnthropic(payload: unknown): NativeOutputItem[] {
  if (!isObject(payload)) return []
  const content = Array.isArray(payload.content) ? payload.content : []
  const output: NativeOutputItem[] = []
  for (const item of content) {
    if (!isObject(item)) continue
    if (item.type === "text") {
      output.push({ type: "text", text: String(item.text || "") })
    } else if (item.type === "thinking") {
      const block = {
        type: "thinking",
        thinking: String(item.thinking || ""),
        signature: String(item.signature || ""),
      } satisfies AnthropicThinkingBlock
      output.push({
        type: "reasoning",
        text: block.thinking,
        anthropicThinkingBlocks: [block],
      })
    } else if (item.type === "redacted_thinking") {
      const block = {
        type: "redacted_thinking",
        data: String(item.data || ""),
      } satisfies AnthropicThinkingBlock
      output.push({
        type: "reasoning",
        text: "",
        anthropicThinkingBlocks: [block],
      })
    } else if (item.type === "tool_use") {
      output.push({
        type: "function_call",
        id: String(item.id || ""),
        callId: String(item.id || ""),
        name: String(item.name || ""),
        argumentsText: argumentsTextFromObject(item.input),
      })
    }
  }
  return output
}

export function toOpenAIResponseFromAnthropic(
  payload: unknown,
  model: string,
  adapter?: Partial<Pick<NativeAdapter, "reverseToolNameMap" | "toolContext">>,
) {
  const stopReason = isObject(payload) ? String(payload.stop_reason || "") : ""
  return buildOpenAIResponseFromNative({
    id: isObject(payload) && typeof payload.id === "string" ? payload.id : undefined,
    model,
    output: outputItemsFromAnthropic(payload),
    usage: openAIUsageFromAnthropic(isObject(payload) ? payload.usage : undefined),
    status: stopReason === "max_tokens" ? "incomplete" : "completed",
    incompleteReason: stopReason === "max_tokens" ? "max_output_tokens" : undefined,
    reverseToolNameMap: adapter?.reverseToolNameMap,
    toolContext: adapter?.toolContext,
  })
}

export function toOpenAIChatFromAnthropic(
  payload: unknown,
  model: string,
  requestedModel = model,
  reverseToolNameMap: Record<string, string> = {},
  toolContext?: NativeAdapter["toolContext"],
) {
  return buildOpenAIChatFromNativeResponse(
    toOpenAIResponseFromAnthropic(payload, model, { reverseToolNameMap, toolContext }),
    requestedModel,
    reverseToolNameMap,
  )
}
