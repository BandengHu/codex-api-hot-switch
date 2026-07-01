import "server-only"

import { createHash } from "node:crypto"
import {
  isHostedWebSearchToolType,
  relayWebSearchChatTool,
  RELAY_WEB_SEARCH_TOOL_NAME,
} from "./web-search-relay"

type AnyRecord = Record<string, any>

export type PatchAction = "add_file" | "delete_file" | "update_file" | "replace_file" | "batch"

export interface CustomToolSpec {
  originalName: string
  kind: "raw" | "apply_patch"
  patchAction?: PatchAction
  metadata?: string
}

export interface FunctionToolSpec {
  namespace: string
  name: string
}

export interface ToolContext {
  customTools: Map<string, CustomToolSpec>
  functionTools: Map<string, FunctionToolSpec>
  toolSearchTools: Set<string>
  webSearchTools: Set<string>
}

export interface SerializedToolContext {
  customTools: Record<string, CustomToolSpec>
  functionTools: Record<string, FunctionToolSpec>
  toolSearchTools?: string[]
  webSearchTools?: string[]
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function canonicalJson(value: unknown): string {
  if (value == null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function outputText(value: unknown) {
  if (typeof value === "string") return value
  if (value == null) return ""
  return canonicalJson(value)
}

const CHAT_TOOL_NAME_MAX_BYTES = 64

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8)
}

function truncateUtf8Prefix(value: string, maxBytes: number) {
  let out = ""
  for (const ch of value) {
    if (Buffer.byteLength(`${out}${ch}`) > maxBytes) break
    out += ch
  }
  return out
}

export function flattenNamespaceToolName(namespace: string, name: string) {
  if (!namespace) return name
  if (!name) return namespace
  const fullName = namespace.endsWith("__") || name.startsWith("__")
    ? `${namespace}${name}`
    : `${namespace}__${name}`
  if (Buffer.byteLength(fullName) <= CHAT_TOOL_NAME_MAX_BYTES) return fullName
  const suffix = `__${shortHash(fullName)}`
  const prefix = truncateUtf8Prefix(fullName, CHAT_TOOL_NAME_MAX_BYTES - Buffer.byteLength(suffix))
  return `${prefix}${suffix}`
}

function proxyPatchActionFromName(name: string): PatchAction | undefined {
  if (name.endsWith("_add_file")) return "add_file"
  if (name.endsWith("_delete_file")) return "delete_file"
  if (name.endsWith("_update_file")) return "update_file"
  if (name.endsWith("_replace_file")) return "replace_file"
  if (name.endsWith("_batch")) return "batch"
  return undefined
}

function detectCustomToolKind(tool: unknown, name: string): "raw" | "apply_patch" {
  if (name === "apply_patch") return "apply_patch"
  if (isObject(tool)) {
    const definition = safeTrim(tool.format?.definition)
    if (
      definition.includes("begin_patch") &&
      definition.includes("end_patch") &&
      definition.includes("add_hunk")
    ) {
      return "apply_patch"
    }
  }
  return "raw"
}

function customToolMetadata(tool: unknown) {
  if (!isObject(tool)) return ""
  return canonicalJson(tool)
}

export function emptyToolContext(): ToolContext {
  return {
    customTools: new Map(),
    functionTools: new Map(),
    toolSearchTools: new Set(),
    webSearchTools: new Set(),
  }
}

export function buildToolContext(tools: unknown): ToolContext {
  const context = emptyToolContext()
  if (!Array.isArray(tools)) return context

  for (const tool of tools) rememberResponseTool(context, tool)
  return context
}

export function rememberResponseTool(context: ToolContext, tool: unknown) {
  if (typeof tool === "string" && tool.trim()) {
    const action = proxyPatchActionFromName(tool)
    context.customTools.set(tool, {
      originalName: action ? "apply_patch" : tool,
      kind: action ? "apply_patch" : "raw",
      ...(action ? { patchAction: action } : {}),
    })
    return
  }
  if (!isObject(tool)) return
  const type = safeTrim(tool.type)
  if (type === "tool_search") {
    context.toolSearchTools.add("tool_search")
    return
  }
  if (isHostedWebSearchToolType(type)) {
    context.webSearchTools.add(RELAY_WEB_SEARCH_TOOL_NAME)
    return
  }
  if (type === "function") {
    const source = isObject(tool.function) ? tool.function : tool
    const name = safeTrim(source.name)
    if (name) context.functionTools.set(name, { namespace: "", name })
    return
  }
  if (type === "custom" || type === "local_shell" || type === "computer_use") {
    const name = safeTrim(tool.name) || type
    const kind = detectCustomToolKind(tool, name)
    const metadata = customToolMetadata(tool)
    if (kind === "apply_patch") {
      context.customTools.set(name, {
        originalName: name,
        kind,
        patchAction: "batch",
        ...(metadata ? { metadata } : {}),
      })
    } else {
      context.customTools.set(name, {
        originalName: name,
        kind,
        ...(metadata ? { metadata } : {}),
      })
    }
    return
  }
  if (type === "namespace") {
    const namespace = safeTrim(tool.name)
    const children = Array.isArray(tool.tools)
      ? tool.tools
      : Array.isArray(tool.children)
        ? tool.children
        : []
    for (const child of children) {
      if (!isObject(child) || child.type !== "function") continue
      const name = safeTrim(child.name)
      if (!name) continue
      const flat = flattenNamespaceToolName(namespace, name)
      context.functionTools.set(flat, { namespace, name })
    }
  }
}

export function serializeToolContext(context: ToolContext): SerializedToolContext {
  return {
    customTools: Object.fromEntries(context.customTools),
    functionTools: Object.fromEntries(context.functionTools),
    toolSearchTools: Array.from(context.toolSearchTools),
    webSearchTools: Array.from(context.webSearchTools),
  }
}

export function deserializeToolContext(context: SerializedToolContext | undefined): ToolContext {
  return {
    customTools: new Map(Object.entries(context?.customTools || {})),
    functionTools: new Map(Object.entries(context?.functionTools || {})),
    toolSearchTools: new Set(context?.toolSearchTools || []),
    webSearchTools: new Set(context?.webSearchTools || []),
  }
}

function normalizeChatToolParameters(parameters: unknown) {
  const out = isObject(parameters) ? { ...parameters } : {}
  out.type ??= "object"
  out.properties ??= {}
  out.required ??= []
  return out
}

function functionTool(name: string, description: string, parameters: AnyRecord) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters,
    },
  }
}

function toolSearchProxyTool() {
  return functionTool(
    "tool_search",
    "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.",
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for tools or connectors to load.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of tool groups to return.",
        },
      },
      required: ["query"],
    },
  )
}

const APPLY_PATCH_EXAMPLE = [
  "Minimal valid patch (note the *** Begin Patch / *** End Patch envelope, the *** Update File: header, and that each body line starts with a space for context, - to remove, or + to add):",
  "*** Begin Patch",
  "*** Update File: path/to/file.ts",
  "@@",
  " unchanged context line",
  "-old line to remove",
  "+new line to add",
  "*** End Patch",
].join("\n")

function applyPatchProxyTool(
  name: string,
  description: string,
  metadata = "",
  includeExample = false,
) {
  const parts = [
    description.trim(),
    "This is the Codex apply_patch FREEFORM tool. Put the complete patch text in the input field, including *** Begin Patch and *** End Patch. Do not split the patch into structured operations.",
    includeExample ? APPLY_PATCH_EXAMPLE : "",
    metadata ? `Original Codex custom tool metadata: ${metadata}` : "",
  ].filter(Boolean)
  return genericCustomProxyTool(name, parts.join("\n\n"))
}

function customProxyDescription(description: string, metadata = "") {
  return [
    description.trim(),
    metadata ? `Original Codex custom tool metadata: ${metadata}` : "",
  ].filter(Boolean).join("\n\n")
}

function genericCustomProxyTool(name: string, description: string) {
  return functionTool(
    name,
    description.trim()
      ? `${description.trim()}\n\nThis is a FREEFORM tool. Put only the raw tool input in the input field.`
      : `FREEFORM custom tool: ${name}. Put only the raw freeform input in the input field.`,
    {
      type: "object",
      additionalProperties: false,
      properties: {
        input: {
          type: "string",
          description: "Raw freeform input for this custom tool.",
        },
      },
      required: ["input"],
    },
  )
}

function responsesFunctionToolToChat(tool: AnyRecord) {
  if (isObject(tool.function)) {
    const fn = { ...tool.function }
    fn.parameters = normalizeChatToolParameters(fn.parameters)
    if (tool.strict != null && fn.strict == null) fn.strict = tool.strict
    return { type: "function", function: fn }
  }
  return {
    type: "function",
    function: {
      name: safeTrim(tool.name),
      description: tool.description || "",
      parameters: normalizeChatToolParameters(tool.parameters),
      ...(tool.strict != null ? { strict: tool.strict } : {}),
    },
  }
}

function combineNamespaceDescription(namespaceDescription: string, childDescription: string) {
  if (!namespaceDescription.trim()) return childDescription.trim()
  if (!childDescription.trim()) return namespaceDescription.trim()
  return `${namespaceDescription.trim()}\n\n${childDescription.trim()}`
}

function namespaceToolToChatTools(tool: AnyRecord) {
  const namespace = safeTrim(tool.name)
  const namespaceDescription = safeTrim(tool.description)
  const children = Array.isArray(tool.tools)
    ? tool.tools
    : Array.isArray(tool.children)
      ? tool.children
      : []
  const out = []
  for (const child of children) {
    if (!isObject(child) || child.type !== "function") continue
    const name = safeTrim(child.name)
    if (!name) continue
    const description = combineNamespaceDescription(namespaceDescription, safeTrim(child.description))
    out.push(
      functionTool(flattenNamespaceToolName(namespace, name), description, normalizeChatToolParameters(child.parameters)),
    )
  }
  return out
}

export function responsesToolsToChatTools(
  tools: unknown[],
  context: ToolContext,
  options: { applyPatchExample?: boolean } = {},
) {
  const out: AnyRecord[] = []
  const seenNames = new Set<string>()
  const pushTool = (tool: AnyRecord) => {
    const name = safeTrim(tool.function?.name)
    if (!name || seenNames.has(name)) return
    seenNames.add(name)
    out.push(tool)
  }
  for (const tool of tools) {
    if (typeof tool === "string" && tool.trim()) {
      pushTool(genericCustomProxyTool(tool, ""))
      continue
    }
    if (!isObject(tool)) continue
    const type = safeTrim(tool.type)
    if (type === "tool_search") {
      context.toolSearchTools.add("tool_search")
      pushTool(toolSearchProxyTool())
    } else if (isHostedWebSearchToolType(type)) {
      context.webSearchTools.add(RELAY_WEB_SEARCH_TOOL_NAME)
      pushTool(relayWebSearchChatTool())
    } else if (type === "function") {
      pushTool(responsesFunctionToolToChat(tool))
    } else if (type === "custom" || type === "local_shell" || type === "computer_use") {
      const name = safeTrim(tool.name) || type
      const description = safeTrim(tool.description)
      const metadata = customToolMetadata(tool)
      if (detectCustomToolKind(tool, name) === "apply_patch") {
        pushTool(applyPatchProxyTool(name, description, metadata, options.applyPatchExample === true))
      } else {
        pushTool(genericCustomProxyTool(name, customProxyDescription(description, metadata)))
      }
    } else if (type === "namespace") {
      for (const chatTool of namespaceToolToChatTools(tool)) pushTool(chatTool)
    }
  }
  return out
}

export function collectToolSearchOutputTools(value: unknown, out: unknown[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectToolSearchOutputTools(item, out))
    return out
  }
  if (!isObject(value)) return out
  if (value.type === "tool_search_output" && Array.isArray(value.tools)) {
    out.push(...value.tools)
  }
  for (const child of Object.values(value)) collectToolSearchOutputTools(child, out)
  return out
}

export function isToolChoiceWithNoSurvivingTool(choice: unknown, context: ToolContext) {
  if (!isObject(choice)) return false
  if (choice.type === "function") {
    const namespace = safeTrim(choice.namespace || choice.function?.namespace)
    const name = safeTrim(choice.name || choice.function?.name)
    if (!name) return true
    return namespace
      ? !context.functionTools.has(flattenNamespaceToolName(namespace, name))
      : !context.functionTools.has(name)
  }
  if (choice.type === "custom") {
    return !context.customTools.has(safeTrim(choice.name))
  }
  if (choice.type === "tool_search") {
    return !context.toolSearchTools.has("tool_search")
  }
  if (isHostedWebSearchToolType(choice.type)) {
    return !context.webSearchTools.has(RELAY_WEB_SEARCH_TOOL_NAME)
  }
  return false
}

export function responsesToolChoiceToChat(choice: unknown, context: ToolContext): unknown {
  if (!isObject(choice)) {
    if (
      typeof choice === "string" &&
      isHostedWebSearchToolType(choice) &&
      context.webSearchTools.has(RELAY_WEB_SEARCH_TOOL_NAME)
    ) {
      return { type: "function", function: { name: RELAY_WEB_SEARCH_TOOL_NAME } }
    }
    return typeof choice === "string" ? choice : undefined
  }
  if (choice.type === "required" || choice.type === "auto" || choice.type === "none") {
    return choice.type
  }
  if (choice.type === "function") {
    const namespace = safeTrim(choice.namespace || choice.function?.namespace)
    const name = safeTrim(choice.name || choice.function?.name)
    if (!name) return undefined
    const upstreamName = namespace ? flattenNamespaceToolName(namespace, name) : name
    if (!context.functionTools.has(upstreamName)) return undefined
    return {
      type: "function",
      function: { name: upstreamName },
    }
  }
  if (choice.type === "custom") {
    const name = safeTrim(choice.name)
    const spec = context.customTools.get(name)
    if (!spec) return undefined
    return { type: "function", function: { name: spec.originalName } }
  }
  if (choice.type === "tool_search") {
    if (!context.toolSearchTools.has("tool_search")) return undefined
    return { type: "function", function: { name: "tool_search" } }
  }
  if (isHostedWebSearchToolType(choice.type)) {
    if (!context.webSearchTools.has(RELAY_WEB_SEARCH_TOOL_NAME)) return undefined
    return { type: "function", function: { name: RELAY_WEB_SEARCH_TOOL_NAME } }
  }
  return choice
}

export function buildCustomToolCallHistory(name: string, inputValue: unknown) {
  const input = outputText(inputValue)
  return { name, arguments: JSON.stringify({ input }) }
}

function withReasoningContent(item: AnyRecord, reasoningContent = ""): AnyRecord {
  const text = safeTrim(reasoningContent)
  return text ? { ...item, reasoning_content: text } : item
}

export function toolCallItem(
  callId: string,
  name: string,
  args: string,
  toolContext: ToolContext,
  reasoningContent = "",
): AnyRecord {
  if (toolContext.toolSearchTools.has(name)) {
    let parsedArguments: unknown = {}
    try {
      parsedArguments = args.trim() ? JSON.parse(args) : {}
    } catch {
      parsedArguments = { query: args }
    }
    return withReasoningContent({
      type: "tool_search_call",
      status: "completed",
      call_id: callId,
      execution: "client",
      arguments: isObject(parsedArguments) ? parsedArguments : { query: args },
    }, reasoningContent)
  }
  if (toolContext.webSearchTools.has(name)) {
    let parsedArguments: unknown = {}
    try {
      parsedArguments = args.trim() ? JSON.parse(args) : {}
    } catch {
      parsedArguments = { query: args }
    }
    const query = isObject(parsedArguments)
      ? String(parsedArguments.query || parsedArguments.search_query || parsedArguments.q || "")
      : args
    return withReasoningContent({
      id: `ws_${callId}`,
      type: "web_search_call",
      status: "completed",
      call_id: callId,
      arguments: args || "{}",
      action: { type: "search", query },
    }, reasoningContent)
  }
  const custom = toolContext.customTools.get(name)
  if (custom) {
    return withReasoningContent({
      id: `ctc_${callId}`,
      type: "custom_tool_call",
      status: "completed",
      call_id: callId,
      name: custom.originalName,
      input:
        custom.kind === "apply_patch"
          ? reconstructApplyPatchInput(custom.patchAction, args)
          : reconstructCustomToolInput(args),
    }, reasoningContent)
  }
  const fn = toolContext.functionTools.get(name)
  return withReasoningContent({
    id: `fc_${callId}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: fn?.name || name,
    ...(fn?.namespace ? { namespace: fn.namespace } : {}),
    arguments: args || "{}",
  }, reasoningContent)
}

export function isCustomToolProxy(name: string, toolContext: ToolContext) {
  return toolContext.customTools.has(name)
}

export function isWebSearchProxy(name: string, toolContext: ToolContext) {
  return toolContext.webSearchTools.has(name)
}

export function toolCallItemId(callId: string, name: string, toolContext: ToolContext) {
  if (toolContext.toolSearchTools.has(name)) return callId
  if (toolContext.webSearchTools.has(name)) return `ws_${callId}`
  return isCustomToolProxy(name, toolContext) ? `ctc_${callId}` : `fc_${callId}`
}

export function toolCallAddedItem(
  callId: string,
  name: string,
  toolContext: ToolContext,
  reasoningContent = "",
): AnyRecord {
  if (toolContext.toolSearchTools.has(name)) {
    return withReasoningContent({
      type: "tool_search_call",
      status: "in_progress",
      call_id: callId,
      execution: "client",
      arguments: {},
    }, reasoningContent)
  }
  if (toolContext.webSearchTools.has(name)) {
    return withReasoningContent({
      id: `ws_${callId}`,
      type: "web_search_call",
      status: "in_progress",
      call_id: callId,
      arguments: "{}",
      action: { type: "search", query: "" },
    }, reasoningContent)
  }
  const custom = toolContext.customTools.get(name)
  if (custom) {
    return withReasoningContent({
      id: `ctc_${callId}`,
      type: "custom_tool_call",
      status: "in_progress",
      call_id: callId,
      name: custom.originalName,
      input: "",
    }, reasoningContent)
  }
  const fn = toolContext.functionTools.get(name)
  return withReasoningContent({
    id: `fc_${callId}`,
    type: "function_call",
    status: "in_progress",
    call_id: callId,
    name: fn?.name || name,
    ...(fn?.namespace ? { namespace: fn.namespace } : {}),
    arguments: "",
  }, reasoningContent)
}

function reconstructCustomToolInput(args: string) {
  try {
    const parsed = JSON.parse(args)
    return outputText(parsed.input ?? parsed)
  } catch {
    return args
  }
}

function reconstructApplyPatchInput(action: PatchAction | undefined, args: string) {
  let value: AnyRecord
  try {
    value = JSON.parse(args)
  } catch {
    return args
  }
  const raw = safeTrim(value.raw_patch || value.patch || value.input)
  if (raw) return raw
  const operations =
    action === "batch" || !action
      ? Array.isArray(value.operations)
        ? value.operations
        : []
      : [{ ...value, type: action }]
  return buildApplyPatchText(operations)
}

function buildApplyPatchText(operations: AnyRecord[]) {
  let text = "*** Begin Patch"
  for (const operation of operations) {
    const path = safeTrim(operation.path)
    if (operation.type === "add_file") {
      text += `\n*** Add File: ${path}`
      for (const line of String(operation.content || "").split(/\r?\n/)) text += `\n+${line}`
    } else if (operation.type === "delete_file") {
      text += `\n*** Delete File: ${path}`
    } else if (operation.type === "update_file") {
      text += `\n*** Update File: ${path}`
      if (operation.move_to) text += `\n*** Move to: ${operation.move_to}`
      for (const hunk of Array.isArray(operation.hunks) ? operation.hunks : []) {
        text += safeTrim(hunk.context) ? `\n@@ ${safeTrim(hunk.context)}` : "\n@@"
        for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) {
          const op = line.op === "add" ? "+" : line.op === "remove" ? "-" : " "
          text += `\n${op}${line.text || ""}`
        }
      }
    } else if (operation.type === "replace_file") {
      text += `\n*** Delete File: ${path}`
      text += `\n*** Add File: ${path}`
      for (const line of String(operation.content || "").split(/\r?\n/)) text += `\n+${line}`
    }
  }
  return `${text}\n*** End Patch`
}
