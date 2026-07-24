import "server-only"

import type { ReasoningEffort } from "@/lib/types"
import { decodeAnthropicThinkingBlocks, type AnthropicThinkingBlock } from "./anthropic-thinking"
import type { ProxyTarget } from "./common"
import { isChatCompletionsPath, isResponsesPath } from "./common"
import { prepareCodexOpenAICompatibleRequest } from "./codex-protocol"
import {
  appendOutputLanguagePolicyToResponsesBody,
  OUTPUT_LANGUAGE_POLICY,
  shouldApplyOutputLanguagePolicy,
} from "./language-policy"
import {
  buildGeminiToolSchemaHints,
  type GeminiToolSchemaHints,
} from "./gemini-tool-args"
import {
  buildCustomToolCallHistory,
  buildToolContext,
  collectToolSearchOutputTools,
  rememberResponseTool,
  responsesToolChoiceToChat,
  responsesToolsToChatTools,
  serializeToolContext,
  type SerializedToolContext,
  type ToolContext,
} from "./codex-tool-proxy"

type AnyRecord = Record<string, any>

const DEFAULT_MAX_OUTPUT_TOKENS = 4096
const ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS = 4096

export type NativeProtocol = "anthropic" | "gemini"
export type NativeSource = "chat_completions" | "responses"

export type CanonicalContentPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "file"; fileData: string; filename?: string }

export type CanonicalResponseFormat =
  | { type: "json_object" }
  | { type: "json_schema"; name?: string; schema: AnyRecord; strict?: boolean }

export type CanonicalInputItem =
  | {
      type: "message"
      role: "user" | "assistant"
      content: CanonicalContentPart[]
    }
  | {
      type: "thinking"
      blocks: AnthropicThinkingBlock[]
    }
  | {
      type: "function_call"
      callId: string
      name: string
      argumentsText: string
      argumentsObject: AnyRecord
      geminiThoughtSignature?: string
    }
  | {
      type: "function_call_output"
      callId: string
      output: string
      outputContent?: CanonicalContentPart[]
    }

export interface CanonicalFunctionTool {
  name: string
  originalName: string
  description: string
  parameters: AnyRecord
  strict?: boolean
}

export type CanonicalToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "any" }
  | { type: "tool"; name: string; originalName: string }

export interface NativeCanonicalRequest {
  source: NativeSource
  requestIsStream: boolean
  requestedModel: string
  modelId: string
  reasoning: ReasoningEffort
  instructions: string
  input: CanonicalInputItem[]
  tools: CanonicalFunctionTool[]
  toolChoice?: CanonicalToolChoice
  parallelToolCalls?: boolean
  stopSequences: string[]
  responseFormat?: CanonicalResponseFormat
  maxOutputTokens: number
  temperature?: number
  topP?: number
  topK?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
  candidateCount?: number
  reverseToolNameMap: Record<string, string>
  toolContext: SerializedToolContext
  geminiToolSchemaHints?: GeminiToolSchemaHints
  historyRequestBody?: AnyRecord
}

export interface NativeAdapter {
  type: "native"
  protocol: NativeProtocol
  source: NativeSource
  requestIsStream: boolean
  requestedModel: string
  reasoningEnabled: boolean
  reverseToolNameMap: Record<string, string>
  toolContext: SerializedToolContext
  geminiToolSchemaHints?: GeminiToolSchemaHints
  historyRequestBody?: AnyRecord
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function normalizedSource(path: string): NativeSource {
  const normalized = path.replace(/^\/+/, "")
  if (isChatCompletionsPath(normalized)) return "chat_completions"
  if (isResponsesPath(normalized)) return "responses"
  throw new Error(`原生协议暂不支持的路径：/${normalized}`)
}

function requestStreamFlag(body: unknown) {
  return isObject(body) ? Boolean(body.stream) : false
}

function numericOption(body: unknown, keys: string[]) {
  if (!isObject(body)) return undefined
  for (const key of keys) {
    const value = body[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function booleanOption(body: unknown, keys: string[]) {
  if (!isObject(body)) return undefined
  for (const key of keys) {
    const value = body[key]
    if (typeof value === "boolean") return value
  }
  return undefined
}

function defaultOutputTokenLimit(target: ProxyTarget) {
  return target.provider.protocol === "anthropic"
    ? ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS
    : DEFAULT_MAX_OUTPUT_TOKENS
}

function outputTokenLimit(body: unknown, target: ProxyTarget) {
  if (isObject(body) && typeof body.text?.max_output_tokens === "number") {
    const value = body.text.max_output_tokens
    if (Number.isFinite(value)) return value
  }
  return (
    numericOption(body, ["max_tokens", "max_output_tokens", "max_completion_tokens"]) ??
    defaultOutputTokenLimit(target)
  )
}

function normalizeStopSequences(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value) return [value]
    if (Array.isArray(value)) {
      const stops = value
        .filter((item): item is string => typeof item === "string" && item.length > 0)
      if (stops.length > 0) return stops
    }
  }
  return []
}

function contentText(content: unknown) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) {
    if (isObject(content) && typeof content.text === "string") return content.text
    return JSON.stringify(content)
  }
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (isObject(part) && typeof part.text === "string") return part.text
      if (isObject(part) && typeof part.content === "string") return part.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function imageUrlFromPart(part: AnyRecord) {
  if (typeof part.image_url === "string") return part.image_url
  if (isObject(part.image_url) && typeof part.image_url.url === "string") {
    return part.image_url.url
  }
  if (typeof part.url === "string") return part.url
  return ""
}

function fileDataFromPart(part: AnyRecord) {
  if (typeof part.file_data === "string") return part.file_data
  if (isObject(part.file) && typeof part.file.file_data === "string") {
    return part.file.file_data
  }
  if (typeof part.file_id === "string") return part.file_id
  if (isObject(part.file) && typeof part.file.file_id === "string") {
    return part.file.file_id
  }
  return ""
}

function normalizeContentParts(content: unknown): CanonicalContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (content == null) return []
  if (!Array.isArray(content)) {
    return [{ type: "text", text: contentText(content) }]
  }

  const parts: CanonicalContentPart[] = []
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part })
      continue
    }
    if (!isObject(part)) {
      throw new Error(`无法转换非对象内容片段：${JSON.stringify(part)}`)
    }
    const type = safeTrim(part.type)
    if (
      type === "text" ||
      type === "input_text" ||
      type === "output_text" ||
      (!type && typeof part.text === "string")
    ) {
      parts.push({ type: "text", text: String(part.text ?? "") })
      continue
    }
    if (type === "input_image" || type === "image_url") {
      const url = imageUrlFromPart(part)
      if (!url) throw new Error("图片内容片段缺少 image_url")
      parts.push({ type: "image", url })
      continue
    }
    if (type === "input_file" || type === "file") {
      const fileData = fileDataFromPart(part)
      if (!fileData) throw new Error("文件内容片段缺少 file_data 或 file_id")
      const filename = safeTrim(part.filename || part.file?.filename)
      parts.push({
        type: "file",
        fileData,
        ...(filename ? { filename } : {}),
      })
      continue
    }
    if (type === "refusal" && typeof part.refusal === "string") {
      parts.push({ type: "text", text: part.refusal })
      continue
    }
    throw new Error(`原生协议暂不支持内容片段类型：${type || "<empty>"}`)
  }
  return parts
}

function normalizeToolResultContent(output: unknown) {
  if (Array.isArray(output)) return normalizeContentParts(output)
  if (isObject(output) && Array.isArray(output.content)) {
    return normalizeContentParts(output.content)
  }
  return undefined
}

function parseArgumentsObject(argumentsText: string): AnyRecord {
  if (!argumentsText.trim()) return {}
  try {
    const parsed = JSON.parse(argumentsText)
    if (isObject(parsed)) return parsed
    return { value: parsed }
  } catch {
    return { input: argumentsText }
  }
}

function normalizeArgumentsText(value: unknown) {
  if (typeof value === "string") return value.trim() ? value : "{}"
  if (value == null) return "{}"
  return JSON.stringify(value)
}

function callIdFromItem(item: AnyRecord, index: number) {
  const existing = safeTrim(
    item.call_id ||
      item.callId ||
      item.tool_call_id ||
      item.toolCallId ||
      item.id ||
      item.item_id ||
      item.itemId,
  )
  if (existing) return existing
  return `call_${index}`
}

function appendInstruction(parts: string[], content: unknown) {
  const text = contentText(content).trim()
  if (text) parts.push(text)
}

function nativeToolBaseName(name: string) {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "_") || "tool"
  if (Buffer.byteLength(cleaned) <= 64) return cleaned
  let out = ""
  for (const ch of cleaned) {
    if (Buffer.byteLength(`${out}${ch}`) > 64) break
    out += ch
  }
  return out || "tool"
}

function buildToolNameMaps(toolNames: string[]) {
  const used = new Set<string>()
  const forward = new Map<string, string>()
  for (const original of toolNames) {
    const base = nativeToolBaseName(original)
    let candidate = base
    let index = 1
    while (used.has(candidate)) {
      const suffix = `_${index++}`
      candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`
    }
    used.add(candidate)
    forward.set(original, candidate)
  }
  const reverse = Object.fromEntries(
    Array.from(forward.entries()).map(([original, native]) => [native, original]),
  )
  return { forward, reverse }
}

function toolNameFromTool(tool: unknown) {
  if (!isObject(tool) || tool.type !== "function") return ""
  if (typeof tool.name === "string") return tool.name
  if (isObject(tool.function) && typeof tool.function.name === "string") {
    return tool.function.name
  }
  return ""
}

function buildTools(rawTools: unknown[]) {
  const names = rawTools.map(toolNameFromTool).filter(Boolean)
  const { forward, reverse } = buildToolNameMaps(names)
  const tools: CanonicalFunctionTool[] = []

  for (const tool of rawTools) {
    if (!isObject(tool)) continue
    if (tool.type !== "function") continue
    const originalName = toolNameFromTool(tool)
    if (!originalName) continue
    const source = isObject(tool.function) ? tool.function : tool
    const parameters = isObject(source.parameters)
      ? source.parameters
      : { type: "object", properties: {} }
    tools.push({
      name: forward.get(originalName) || originalName,
      originalName,
      description: String(source.description || ""),
      parameters,
      ...(source.strict != null ? { strict: Boolean(source.strict) } : {}),
    })
  }

  return { tools, forwardToolNameMap: forward, reverseToolNameMap: reverse }
}

function nativeToolsAndContext(body: AnyRecord) {
  const responseTools = Array.isArray(body.tools) ? body.tools : []
  const toolContext = buildToolContext(responseTools)
  const loadedTools = collectToolSearchOutputTools(body.input)
  for (const tool of loadedTools) rememberResponseTool(toolContext, tool)
  const nativeCompatibleTools = responsesToolsToChatTools(
    [...responseTools, ...loadedTools],
    toolContext,
    { applyPatchExample: true },
  )
  return {
    toolContext,
    ...buildTools(nativeCompatibleTools),
  }
}

function normalizeResponseFormat(...bodies: unknown[]): CanonicalResponseFormat | undefined {
  for (const body of bodies) {
    if (!isObject(body)) continue
    const rawFormat = body.response_format ?? body.text?.format
    if (!isObject(rawFormat)) continue

    if (rawFormat.type === "json_object") return { type: "json_object" }

    if (rawFormat.type === "json_schema") {
      const source = isObject(rawFormat.json_schema) ? rawFormat.json_schema : rawFormat
      const schema = source.schema
      if (!isObject(schema)) continue
      return {
        type: "json_schema",
        ...(typeof source.name === "string" && source.name.trim()
          ? { name: source.name.trim() }
          : {}),
        schema,
        ...(typeof source.strict === "boolean" ? { strict: source.strict } : {}),
      }
    }
  }
  return undefined
}

function combineReverseToolNameMaps(
  nativeReverse: Record<string, string>,
  preparedReverse: Record<string, string> | undefined,
) {
  if (!preparedReverse || Object.keys(preparedReverse).length === 0) {
    return nativeReverse
  }
  return Object.fromEntries(
    Object.entries(nativeReverse).map(([nativeName, preparedName]) => [
      nativeName,
      preparedReverse[preparedName] || preparedName,
    ]),
  )
}

function normalizeToolChoice(
  choice: unknown,
  forwardToolNameMap: Map<string, string>,
): CanonicalToolChoice | undefined {
  if (choice == null) return undefined
  if (typeof choice === "string") {
    if (choice === "required" || choice === "any") return { type: "any" }
    if (choice === "none") return { type: "none" }
    if (choice === "auto") return { type: "auto" }
    return undefined
  }
  if (!isObject(choice)) return undefined
  const type = safeTrim(choice.type)
  if (type === "required" || type === "any") return { type: "any" }
  if (type === "none") return { type: "none" }
  if (type === "auto") return { type: "auto" }
  if (type === "function") {
    const originalName = safeTrim(choice.name || choice.function?.name)
    if (!originalName) return undefined
    return {
      type: "tool",
      originalName,
      name: forwardToolNameMap.get(originalName) || nativeToolBaseName(originalName),
    }
  }
  return undefined
}

function mappedToolCallName(params: {
  rawItem: AnyRecord
  argumentsText: string
  forwardToolNameMap: Map<string, string>
  toolContext: ToolContext
}) {
  const originalName = safeTrim(params.rawItem.name || params.rawItem.function?.name)
  if (!originalName) return ""
  if (params.forwardToolNameMap.has(originalName)) {
    return params.forwardToolNameMap.get(originalName) || originalName
  }

  const customSpec = params.toolContext.customTools.get(originalName)
  if (customSpec?.kind === "apply_patch" || params.toolContext.customTools.has(`${originalName}_batch`)) {
    const parsed = parseArgumentsObject(params.argumentsText)
    const rebuilt = buildCustomToolCallHistory(
      customSpec?.originalName || originalName,
      parsed.input ?? params.argumentsText,
    )
    if (params.toolContext.customTools.has(rebuilt.name)) {
      params.rawItem.arguments = rebuilt.arguments
      return params.forwardToolNameMap.get(rebuilt.name) || nativeToolBaseName(rebuilt.name)
    }
  }

  if (customSpec) {
    return params.forwardToolNameMap.get(originalName) || nativeToolBaseName(originalName)
  }

  return nativeToolBaseName(originalName)
}

function normalizeInputItems(
  body: AnyRecord,
  forwardToolNameMap: Map<string, string>,
  toolContext: ToolContext,
) {
  const input = Array.isArray(body.input)
    ? body.input
    : typeof body.input === "string"
      ? [{ type: "message", role: "user", content: body.input }]
      : []
  const instructions = [safeTrim(body.instructions)].filter(Boolean)
  const items: CanonicalInputItem[] = []

  input.forEach((rawItem, index) => {
    if (!isObject(rawItem)) {
      throw new Error(`input[${index}] 不是对象，无法转换到原生协议`)
    }
    const type = safeTrim(rawItem.type || (rawItem.role ? "message" : ""))
    if (type === "message") {
      const role = safeTrim(rawItem.role || "user").toLowerCase()
      if (role === "system" || role === "developer") {
        appendInstruction(instructions, rawItem.content)
        return
      }
      if (role !== "user" && role !== "assistant") {
        throw new Error(`原生协议暂不支持 message.role=${role || "<empty>"}`)
      }
      items.push({
        type: "message",
        role,
        content: normalizeContentParts(rawItem.content),
      })
      return
    }
    if (type === "function_call") {
      const originalName = safeTrim(rawItem.name || rawItem.function?.name)
      if (!originalName) throw new Error(`function_call[${index}] 缺少 name`)
      const argumentsText = normalizeArgumentsText(
        rawItem.arguments ?? rawItem.function?.arguments,
      )
      items.push({
        type: "function_call",
        callId: callIdFromItem(rawItem, index),
        name: mappedToolCallName({
          rawItem,
          argumentsText,
          forwardToolNameMap,
          toolContext,
        }),
        argumentsText: normalizeArgumentsText(
          rawItem.arguments ?? rawItem.function?.arguments,
        ),
        argumentsObject: parseArgumentsObject(
          normalizeArgumentsText(rawItem.arguments ?? rawItem.function?.arguments),
        ),
        geminiThoughtSignature: safeTrim(
          rawItem.gemini_thought_signature ||
          rawItem.thoughtSignature ||
          rawItem.thought_signature,
        ) || undefined,
      })
      return
    }
    if (type === "custom_tool_call" || type === "tool_search_call") {
      const name = type === "tool_search_call" ? "tool_search" : safeTrim(rawItem.name) || "custom_tool"
      const built =
        type === "tool_search_call"
          ? { name, arguments: normalizeArgumentsText(rawItem.arguments ?? {}) }
          : buildCustomToolCallHistory(name, rawItem.input ?? rawItem.arguments)
      items.push({
        type: "function_call",
        callId: callIdFromItem(rawItem, index),
        name: forwardToolNameMap.get(built.name) || nativeToolBaseName(built.name),
        argumentsText: built.arguments,
        argumentsObject: parseArgumentsObject(built.arguments),
        geminiThoughtSignature: safeTrim(
          rawItem.gemini_thought_signature ||
          rawItem.thoughtSignature ||
          rawItem.thought_signature,
        ) || undefined,
      })
      return
    }
    if (type === "function_call_output") {
      const callId = safeTrim(
        rawItem.call_id ||
          rawItem.callId ||
          rawItem.tool_call_id ||
          rawItem.toolCallId ||
          rawItem.id,
      )
      if (!callId) throw new Error(`function_call_output[${index}] 缺少 call_id`)
      const outputValue = rawItem.output ?? rawItem.content ?? rawItem.text ?? ""
      const outputContent = normalizeToolResultContent(outputValue)
      items.push({
        type: "function_call_output",
        callId,
        output: contentText(outputValue),
        ...(outputContent && outputContent.length > 0 ? { outputContent } : {}),
      })
      return
    }
    if (type === "custom_tool_call_output" || type === "tool_search_output") {
      const callId = safeTrim(
        rawItem.call_id ||
          rawItem.callId ||
          rawItem.tool_call_id ||
          rawItem.toolCallId ||
          rawItem.id,
      )
      if (!callId) throw new Error(`${type}[${index}] 缺少 call_id`)
      const outputValue = rawItem.output ?? rawItem.content ?? rawItem.text ?? rawItem
      items.push({
        type: "function_call_output",
        callId,
        output: contentText(outputValue),
      })
      return
    }
    if (type === "web_search_call") {
      return
    }
    if (type === "reasoning") {
      const blocks = decodeAnthropicThinkingBlocks(
        rawItem.encrypted_content ?? rawItem.encryptedContent,
      )
      if (blocks.length > 0) {
        items.push({ type: "thinking", blocks })
      }
      return
    }
    throw new Error(`原生协议暂不支持 input[${index}].type=${type || "<empty>"}`)
  })

  if (items.length === 0) {
    items.push({ type: "message", role: "user", content: [{ type: "text", text: "" }] })
  }

  return { instructions: instructions.join("\n\n"), input: items }
}

function appendOutputLanguagePolicyToLatestUserContext(
  input: CanonicalInputItem[],
  target: ProxyTarget,
) {
  if (!shouldApplyOutputLanguagePolicy(target)) return
  const last = input.at(-1)
  if (last?.type === "message" && last.role === "user") {
    if (
      last.content.some(
        (part) => part.type === "text" && part.text.includes(OUTPUT_LANGUAGE_POLICY),
      )
    ) {
      return
    }
    last.content.push({ type: "text", text: OUTPUT_LANGUAGE_POLICY })
    return
  }
  input.push({
    type: "message",
    role: "user",
    content: [{ type: "text", text: OUTPUT_LANGUAGE_POLICY }],
  })
}

export function buildNativeCanonicalRequest(
  target: ProxyTarget,
  path: string,
  body: unknown,
): NativeCanonicalRequest {
  const source = normalizedSource(path)
  const prepared = prepareCodexOpenAICompatibleRequest(
    path,
    body,
    target.modelId,
    target.reasoning,
    { preserveRequestControls: target.paused },
  )
  appendOutputLanguagePolicyToResponsesBody(prepared.body, target)
  if (!isObject(prepared.body)) {
    throw new Error("归一化后的请求体不是 JSON 对象")
  }
  if (safeTrim(prepared.body.previous_response_id)) {
    throw new Error(
      "原生 Anthropic/Gemini 协议无法解析 OpenAI previous_response_id，请让客户端发送完整历史或切换 OpenAI Compatible 供应商",
    )
  }

  const responseSourceBody =
    source === "responses" && isObject(body) ? body : prepared.body
  const { tools, forwardToolNameMap, reverseToolNameMap, toolContext } =
    nativeToolsAndContext(responseSourceBody)
  const { instructions, input } = normalizeInputItems(
    prepared.body,
    forwardToolNameMap,
    toolContext,
  )
  appendOutputLanguagePolicyToLatestUserContext(input, target)
  const requestedModel =
    safeTrim(prepared.adapter.requestedModel) || safeTrim((body as AnyRecord)?.model)
  const preparedReverseToolNameMap =
    prepared.adapter.type === "chat_completions"
      ? prepared.adapter.reverseToolNameMap
      : undefined

  return {
    source,
    requestIsStream: requestStreamFlag(body),
    requestedModel,
    modelId: target.modelId,
    reasoning: target.reasoning,
    instructions,
    input,
    tools,
    toolChoice: normalizeToolChoice(
      responsesToolChoiceToChat(responseSourceBody.tool_choice, toolContext),
      forwardToolNameMap,
    ),
    parallelToolCalls:
      booleanOption(body, ["parallel_tool_calls"]) ??
      booleanOption(prepared.body, ["parallel_tool_calls"]),
    stopSequences: normalizeStopSequences(
      prepared.body.stop,
      prepared.body.stop_sequences,
      (body as AnyRecord)?.stop,
      (body as AnyRecord)?.stop_sequences,
    ),
    responseFormat: normalizeResponseFormat(prepared.body, body),
    maxOutputTokens: outputTokenLimit(body, target),
    temperature: numericOption(body, ["temperature"]),
    topP: numericOption(body, ["top_p"]),
    topK: numericOption(body, ["top_k", "topK"]),
    frequencyPenalty: numericOption(body, ["frequency_penalty", "frequencyPenalty"]),
    presencePenalty: numericOption(body, ["presence_penalty", "presencePenalty"]),
    seed: numericOption(body, ["seed"]),
    candidateCount: numericOption(body, ["n", "candidate_count", "candidateCount"]),
    reverseToolNameMap: combineReverseToolNameMaps(
      reverseToolNameMap,
      preparedReverseToolNameMap,
    ),
    toolContext: serializeToolContext(toolContext),
    geminiToolSchemaHints: buildGeminiToolSchemaHints(tools),
    historyRequestBody:
      prepared.adapter.type === "passthrough"
        ? prepared.adapter.historyRequestBody ?? prepared.body
        : prepared.body,
  }
}

export function nativeAdapter(
  protocol: NativeProtocol,
  canonical: NativeCanonicalRequest,
): NativeAdapter {
  return {
    type: "native",
    protocol,
    source: canonical.source,
    requestIsStream: canonical.requestIsStream,
    requestedModel: canonical.requestedModel,
    reasoningEnabled: canonical.reasoning !== "off",
    reverseToolNameMap: canonical.reverseToolNameMap,
    toolContext: canonical.toolContext,
    geminiToolSchemaHints: canonical.geminiToolSchemaHints,
    historyRequestBody: canonical.historyRequestBody,
  }
}
