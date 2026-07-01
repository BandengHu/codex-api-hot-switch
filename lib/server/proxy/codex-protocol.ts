import "server-only"

import type { ReasoningEffort } from "@/lib/types"
import { isChatCompletionsPath, isResponsesCompactPath, isResponsesPath } from "./common"
import { expandCodexResponsesRequest } from "./codex-chat-history"
import { ProxyRequestBodyError } from "./content-encoding"
import { canonicalToolArguments } from "./json-canonical"

type AnyRecord = Record<string, any>

export type CodexAdapter =
  | {
      type: "passthrough"
      requestIsStream: boolean
      requestedModel: string
      responseModelOverride?: string
    }
  | {
      type: "chat_completions"
      stream: boolean
      requestedModel: string
      reverseToolNameMap: Record<string, string>
    }

export interface PreparedCodexRequest {
  upstreamPath: string
  body: AnyRecord
  adapter: CodexAdapter
}

interface PrepareCodexRequestOptions {
  preserveRequestControls?: boolean
  rawResponsesPassthrough?: boolean
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function responseTextTypeForRole(role: string) {
  return role.toLowerCase() === "assistant" ? "output_text" : "input_text"
}

function textPart(role: string, text: unknown) {
  return { type: responseTextTypeForRole(role), text: String(text ?? "") }
}

function normalizeContentPart(part: unknown, role: string) {
  if (!isObject(part)) return part
  const next = { ...part }
  if (next.content && !next.text && typeof next.content === "string") {
    next.text = next.content
    delete next.content
  }
  if (next.type === "text" || (!next.type && next.text != null)) {
    next.type = responseTextTypeForRole(role)
  } else if (next.type === "input_text" && role === "assistant") {
    next.type = "output_text"
  } else if (next.type === "output_text" && role !== "assistant") {
    next.type = "input_text"
  } else if (next.type === "image_url" && next.image_url) {
    next.type = "input_image"
    next.image_url =
      typeof next.image_url === "string" ? next.image_url : next.image_url.url
  } else if (next.type === "file" && role === "user") {
    const file = isObject(next.file) ? next.file : {}
    const fileData = safeTrim(file.file_data || next.file_data)
    if (fileData) {
      next.type = "input_file"
      next.file_data = fileData
      const filename = safeTrim(file.filename || next.filename)
      if (filename) next.filename = filename
      delete next.file
    }
  }
  return next
}

function normalizeMessageContent(content: unknown, role: string) {
  if (typeof content === "string") return [textPart(role, content)]
  if (Array.isArray(content)) {
    return content.map((part) => normalizeContentPart(part, role))
  }
  if (content == null) return []
  return [textPart(role, JSON.stringify(content))]
}

function contentToText(content: unknown): string {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (isObject(part) && part.text != null) return String(part.text)
        if (isObject(part) && part.type === "text" && part.content != null) {
          return String(part.content)
        }
        return JSON.stringify(part)
      })
      .join("")
  }
  return JSON.stringify(content)
}

function callIdFromInputItem(item: AnyRecord) {
  return safeTrim(
    item.call_id ||
      item.callId ||
      item.tool_call_id ||
      item.toolCallId ||
      item.item_id ||
      item.itemId ||
      item.id,
  )
}

function normalizeFunctionArguments(value: unknown) {
  return canonicalToolArguments(value)
}

function parseObjectJson(text: string) {
  if (!text.trim()) return null
  try {
    const parsed = JSON.parse(text)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function inferFunctionNameFromArguments(argumentsText: string) {
  const parsed = parseObjectJson(argumentsText)
  if (!parsed) return ""
  if (Array.isArray(parsed.targets) && Object.hasOwn(parsed, "timeout_ms")) {
    return "wait_agent"
  }
  if (
    typeof parsed.message === "string" ||
    Object.hasOwn(parsed, "fork_context") ||
    Object.hasOwn(parsed, "agent_type")
  ) {
    return "spawn_agent"
  }
  return ""
}

function normalizeCustomToolInputArguments(item: AnyRecord) {
  const raw = item.input ?? item.arguments ?? item.content ?? ""
  if (typeof raw === "string") {
    if (!raw.trim()) return "{}"
    try {
      JSON.parse(raw.trim())
      return raw.trim()
    } catch {
      return JSON.stringify({ input: raw })
    }
  }
  return normalizeFunctionArguments(raw)
}

function normalizeResponsesInputItem(item: unknown): unknown {
  if (!isObject(item)) return item
  const out = { ...item }
  if (!out.type && (out.role || out.content)) out.type = "message"

  if (out.type === "message") {
    const rawRole = safeTrim(out.role || "user").toLowerCase()
    const role = rawRole === "system" ? "developer" : rawRole
    out.role = role || "user"
    if (out.content != null) {
      out.content = normalizeMessageContent(out.content, out.role)
    }
    return out
  }

  delete out.role
  if (out.type === "custom_tool_call") {
    const callId = callIdFromInputItem(out)
    const name = safeTrim(out.name || out.tool_name || out.toolName || "custom_tool")
    return {
      type: "function_call",
      ...(callId ? { call_id: callId } : {}),
      name,
      arguments: normalizeCustomToolInputArguments(out),
    }
  }
  if (out.type === "custom_tool_call_output") {
    const callId = callIdFromInputItem(out)
    return {
      type: "function_call_output",
      ...(callId ? { call_id: callId } : {}),
      output: contentToText(out.output ?? out.content ?? out.text ?? ""),
    }
  }
  if (out.type === "function_call") {
    const callId = callIdFromInputItem(out)
    if (callId) out.call_id = callId
    if (isObject(out.function)) {
      out.name = out.name || out.function.name
      out.arguments = out.arguments ?? out.function.arguments
      delete out.function
    }
    out.arguments = normalizeFunctionArguments(out.arguments)
    out.name = safeTrim(out.name) || inferFunctionNameFromArguments(out.arguments)
    for (const key of ["callId", "tool_call_id", "toolCallId", "item_id", "itemId"]) {
      delete out[key]
    }
  } else if (out.type === "function_call_output") {
    const callId = callIdFromInputItem(out)
    if (callId) out.call_id = callId
    for (const key of ["callId", "tool_call_id", "toolCallId", "item_id", "itemId"]) {
      delete out[key]
    }
  }
  return out
}

function isApplyPatchToolName(name: unknown) {
  return safeTrim(name).toLowerCase() === "apply_patch"
}

function buildApplyPatchFunctionTool(source: AnyRecord = {}) {
  return {
    type: "function",
    name: "apply_patch",
    description: safeTrim(source.description) || "Apply a patch to files.",
    parameters: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "The complete apply_patch patch text.",
        },
      },
      required: ["input"],
      additionalProperties: false,
    },
    strict: true,
  }
}

function normalizeBuiltinToolValue(value: unknown, options: { mode?: "choice" } = {}) {
  if (!isObject(value) || typeof value.type !== "string") return value
  if (
    value.type === "custom" &&
    isApplyPatchToolName(value.name || value.tool_name || value.toolName)
  ) {
    return options.mode === "choice"
      ? { type: "function", name: "apply_patch" }
      : buildApplyPatchFunctionTool(value)
  }
  if (value.type === "web_search_preview" || value.type === "web_search_preview_2025_03_11") {
    return { ...value, type: "web_search" }
  }
  if (value.type === "function" && isObject(value.function)) {
    const fn = value.function
    return {
      type: "function",
      name: fn.name || value.name,
      description: fn.description || value.description || "",
      parameters: fn.parameters || value.parameters || { type: "object", properties: {} },
      ...(fn.strict != null ? { strict: fn.strict } : {}),
    }
  }
  return value
}

function isInvalidFunctionToolValue(value: unknown) {
  return isObject(value) && value.type === "function" && !safeTrim(value.name)
}

function messageItem(role: string, text: unknown) {
  return { type: "message", role, content: [textPart(role, text)] }
}

export function normalizeResponsesBodyForCodex(body: unknown) {
  if (!isObject(body)) return body
  const out = { ...body }
  out.instructions = typeof out.instructions === "string" ? out.instructions : ""
  out.stream = true
  out.store = false

  const previousResponseId = safeTrim(out.previous_response_id)
  if (previousResponseId) out.previous_response_id = previousResponseId
  else delete out.previous_response_id

  if (!Array.isArray(out.include)) {
    out.include = ["reasoning.encrypted_content"]
  } else if (!out.include.includes("reasoning.encrypted_content")) {
    out.include = [...out.include, "reasoning.encrypted_content"]
  }

  if (typeof out.input === "string") {
    out.input = [messageItem("user", out.input)]
  } else if (Array.isArray(out.input)) {
    out.input = out.input.map(normalizeResponsesInputItem)
  } else if (isObject(out.input)) {
    out.input = [normalizeResponsesInputItem(out.input)]
  }

  if (Array.isArray(out.tools)) {
    out.tools = out.tools
      .map((tool) => normalizeBuiltinToolValue(tool))
      .filter((tool) => !isInvalidFunctionToolValue(tool))
  }
  const hasTools = Array.isArray(out.tools) && out.tools.length > 0
  if (hasTools) {
    if (typeof out.parallel_tool_calls !== "boolean") out.parallel_tool_calls = true
  } else {
    delete out.tool_choice
    delete out.parallel_tool_calls
  }
  if (hasTools && isObject(out.tool_choice)) {
    out.tool_choice = normalizeBuiltinToolValue(out.tool_choice, { mode: "choice" })
    if (isInvalidFunctionToolValue(out.tool_choice)) delete out.tool_choice
    else if (Array.isArray(out.tool_choice.tools)) {
      out.tool_choice.tools = out.tool_choice.tools
        .map((tool: unknown) => normalizeBuiltinToolValue(tool, { mode: "choice" }))
        .filter((tool: unknown) => !isInvalidFunctionToolValue(tool))
    }
  }

  if (out.max_completion_tokens != null && out.max_output_tokens == null) {
    out.max_output_tokens = out.max_completion_tokens
  }
  delete out.max_completion_tokens
  return out
}

function shortenToolName(name: string) {
  const raw = safeTrim(name)
  if (Buffer.byteLength(raw) <= 64) return raw
  const parts = raw.startsWith("mcp__") ? raw.split("__") : []
  const base = parts.length >= 3 ? `mcp__${parts.at(-1)}` : raw
  let out = ""
  for (const ch of base) {
    if (Buffer.byteLength(`${out}${ch}`) > 64) break
    out += ch
  }
  return out
}

function buildShortToolNameMap(body: AnyRecord) {
  const names: string[] = []
  for (const tool of body.tools || []) {
    const name = tool?.type === "function" ? tool.function?.name || tool.name : ""
    if (name) names.push(name)
  }
  const used = new Set<string>()
  const map = new Map<string, string>()
  for (const name of names) {
    let candidate = shortenToolName(name)
    let index = 1
    while (used.has(candidate)) {
      const suffix = `_${index++}`
      candidate = `${shortenToolName(name).slice(0, 64 - suffix.length)}${suffix}`
    }
    used.add(candidate)
    map.set(name, candidate)
  }
  return map
}

function normalizeChatToolCall(toolCall: AnyRecord, shortNameMap: Map<string, string>) {
  const id = safeTrim(toolCall?.id || toolCall?.call_id)
  const fn = toolCall?.function || {}
  const name = safeTrim(fn.name)
  if (!id || !name) return null
  return {
    type: "function_call",
    call_id: id,
    name: shortNameMap.get(name) || name,
    arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
  }
}

function normalizeChatMessage(message: unknown, shortNameMap: Map<string, string>) {
  if (!isObject(message)) return []
  const role = safeTrim(message.role || "user").toLowerCase()
  if (role === "tool") {
    const callId = safeTrim(message.tool_call_id)
    return callId
      ? [{ type: "function_call_output", call_id: callId, output: contentToText(message.content) }]
      : []
  }
  const items: unknown[] = []
  const mappedRole = role === "system" ? "developer" : role
  const content = normalizeMessageContent(message.content, mappedRole)
  if (content.length > 0) {
    items.push({ type: "message", role: mappedRole || "user", content })
  }
  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      const normalized = normalizeChatToolCall(toolCall, shortNameMap)
      if (normalized) items.push(normalized)
    }
  }
  return items
}

function normalizeChatTool(tool: unknown, shortNameMap: Map<string, string>) {
  if (!isObject(tool)) return null
  if (tool.type !== "function") return normalizeBuiltinToolValue(tool)
  const fn = tool.function || tool
  const name = safeTrim(fn.name)
  if (!name) return null
  return {
    type: "function",
    name: shortNameMap.get(name) || name,
    description: fn.description || "",
    parameters: fn.parameters || { type: "object", properties: {} },
    ...(fn.strict != null ? { strict: fn.strict } : {}),
  }
}

function normalizeChatToolChoice(choice: unknown, shortNameMap: Map<string, string>) {
  if (typeof choice === "string") return choice
  if (!isObject(choice)) return undefined
  if (choice.type === "required" || choice.type === "auto" || choice.type === "none") {
    return choice.type
  }
  if (choice.type === "function") {
    const name = safeTrim(choice.function?.name || choice.name)
    return name ? { type: "function", name: shortNameMap.get(name) || name } : undefined
  }
  return normalizeBuiltinToolValue(choice)
}

function copyDefinedFields(source: AnyRecord, target: AnyRecord, fields: string[]) {
  for (const field of fields) {
    if (source[field] != null) target[field] = source[field]
  }
}

function chatResponseFormatToResponsesTextFormat(format: unknown) {
  if (!isObject(format)) return undefined
  if (format.type === "text") return { type: "text" }
  if (format.type === "json_object") return { type: "json_object" }
  if (format.type === "json_schema" && isObject(format.json_schema)) {
    return { type: "json_schema", ...format.json_schema }
  }
  return undefined
}

export function buildResponsesBodyFromChatCompletions(body: unknown) {
  if (!isObject(body)) throw new Error("chat/completions 请求体必须是 JSON 对象")
  const model = safeTrim(body.model)
  if (!model) throw new Error("chat/completions 请求缺少 model")
  if (!Array.isArray(body.messages)) throw new Error("chat/completions 请求缺少 messages")

  const shortNameMap = buildShortToolNameMap(body)
  const responsesBody: AnyRecord = {
    instructions: "",
    stream: true,
    store: false,
    model,
    input: body.messages.flatMap((message: unknown) =>
      normalizeChatMessage(message, shortNameMap),
    ),
    include: ["reasoning.encrypted_content"],
  }

  const reasoningEffort = body.reasoning_effort || body.reasoning?.effort
  if (reasoningEffort) {
    responsesBody.reasoning = {
      effort: reasoningEffort,
      summary: body.reasoning?.summary || "auto",
    }
  }

  copyDefinedFields(body, responsesBody, [
    "temperature",
    "top_p",
    "metadata",
    "truncation",
    "service_tier",
    "previous_response_id",
    "prompt_cache_retention",
    "safety_identifier",
    "stream_options",
    "user",
  ])
  if (body.max_output_tokens != null) {
    responsesBody.max_output_tokens = body.max_output_tokens
  } else if (body.max_completion_tokens != null) {
    responsesBody.max_output_tokens = body.max_completion_tokens
  } else if (body.max_tokens != null) {
    responsesBody.max_output_tokens = body.max_tokens
  }
  if (body.stop != null) responsesBody.stop = body.stop

  if (Array.isArray(body.tools)) {
    responsesBody.tools = body.tools
      .map((tool: unknown) => normalizeChatTool(tool, shortNameMap))
      .filter(Boolean)
  }
  const hasTools = Array.isArray(responsesBody.tools) && responsesBody.tools.length > 0
  if (hasTools) {
    responsesBody.parallel_tool_calls =
      typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : true
  } else {
    delete responsesBody.tools
  }
  if (hasTools && body.tool_choice != null) {
    const toolChoice = normalizeChatToolChoice(body.tool_choice, shortNameMap)
    if (toolChoice != null) responsesBody.tool_choice = toolChoice
  }
  const text: AnyRecord = {}
  const format = chatResponseFormatToResponsesTextFormat(body.response_format)
  if (format) text.format = format
  if (body.text?.verbosity) text.verbosity = body.text.verbosity
  if (Object.keys(text).length > 0) responsesBody.text = text

  return {
    body: responsesBody,
    stream: Boolean(body.stream),
    requestedModel: model,
    reverseToolNameMap: Object.fromEntries(
      Array.from(shortNameMap.entries()).map(([full, short]) => [short, full]),
    ),
  }
}

export function applyHotSwitchOverrides(body: AnyRecord, model: string, reasoning: ReasoningEffort) {
  body.model = model
  if (reasoning === "off") {
    delete body.reasoning
    delete body.reasoning_effort
    return
  }
  if (reasoning === "auto") return
  body.reasoning = isObject(body.reasoning)
    ? { ...body.reasoning, effort: reasoning }
    : { effort: reasoning, summary: "auto" }
}

export function prepareCodexOpenAICompatibleRequest(
  path: string,
  body: unknown,
  model: string,
  reasoning: ReasoningEffort,
  options: PrepareCodexRequestOptions = {},
): PreparedCodexRequest {
  const normalizedPath = path.replace(/^\/+/, "")
  if (isChatCompletionsPath(normalizedPath)) {
    const mapped = buildResponsesBodyFromChatCompletions(body)
    if (!options.preserveRequestControls) {
      applyHotSwitchOverrides(mapped.body, model, reasoning)
    }
    return {
      upstreamPath: "v1/responses",
      body: mapped.body,
      adapter: {
        type: "chat_completions",
        stream: mapped.stream,
        requestedModel: mapped.requestedModel,
        reverseToolNameMap: mapped.reverseToolNameMap,
      },
    }
  }

  if (isResponsesCompactPath(normalizedPath)) {
    if (!isObject(body)) throw new Error("responses/compact 请求体必须是合法 JSON 对象")
    const passthrough = { ...body }
    if (passthrough.stream === true) {
      throw new ProxyRequestBodyError("OpenAI Responses compact 不支持 stream=true", 400)
    }
    delete passthrough.stream
    if (!options.preserveRequestControls) {
      applyHotSwitchOverrides(passthrough, model, reasoning)
    }
    return {
      upstreamPath: "v1/responses/compact",
      body: passthrough,
      adapter: {
        type: "passthrough",
        requestIsStream: false,
        requestedModel: safeTrim(passthrough.model),
        responseModelOverride: undefined,
      },
    }
  }

  if (isResponsesPath(normalizedPath)) {
    if (!isObject(body)) throw new Error("responses 请求体必须是合法 JSON 对象")
    const passthrough = { ...body }
    const requestedModel = safeTrim(passthrough.model)
    if (options.preserveRequestControls || options.rawResponsesPassthrough) {
      if (!options.preserveRequestControls) {
        applyHotSwitchOverrides(passthrough, model, reasoning)
      }
      return {
        upstreamPath: "v1/responses",
        body: passthrough,
        adapter: {
          type: "passthrough",
          requestIsStream: Boolean(passthrough.stream),
          requestedModel,
          responseModelOverride: requestedModel || safeTrim(body.model) || undefined,
        },
      }
    }
    {
      applyHotSwitchOverrides(passthrough, model, reasoning)
      expandCodexResponsesRequest(passthrough)
    }
    const normalized = normalizeResponsesBodyForCodex(passthrough)
    if (!isObject(normalized)) throw new Error("归一化后的 responses 请求体不是 JSON 对象")
    return {
      upstreamPath: "v1/responses",
      body: normalized,
      adapter: {
        type: "passthrough",
        requestIsStream: Boolean(normalized.stream),
        requestedModel,
        responseModelOverride: requestedModel || safeTrim(body.model) || undefined,
      },
    }
  }

  if (!isObject(body)) throw new Error("OpenAI Compatible 请求体必须是 JSON 对象")
  const passthrough = { ...body }
  if (!options.preserveRequestControls) {
    applyHotSwitchOverrides(passthrough, model, reasoning)
  }
  return {
    upstreamPath: normalizedPath,
    body: passthrough,
    adapter: {
      type: "passthrough",
      requestIsStream: Boolean(passthrough.stream),
      requestedModel: safeTrim(body.model),
    },
  }
}
