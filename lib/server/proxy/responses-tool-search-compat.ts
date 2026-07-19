import "server-only"

import {
  collectToolSearchOutputTools,
  flattenNamespaceToolName,
  rememberResponseTool,
  toolCallItem,
  type ToolContext,
} from "./codex-tool-proxy"

type AnyRecord = Record<string, any>

export type CompatibleResponsesFunctionProxyKind =
  | "custom"
  | "tool_search"
  | "namespaced_function"

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function callIdFromItem(item: AnyRecord) {
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

function functionArguments(value: unknown) {
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return "{}"
    try {
      JSON.parse(text)
      return text
    } catch {
      return JSON.stringify({ input: value })
    }
  }
  return JSON.stringify(value ?? {})
}

function functionParameters(value: unknown) {
  if (!isObject(value)) {
    return { type: "object", properties: {}, required: [] }
  }
  return {
    ...value,
    type: value.type || "object",
    properties: isObject(value.properties) ? value.properties : {},
    required: Array.isArray(value.required) ? value.required : [],
  }
}

function responseFunctionTool(
  name: string,
  description: string,
  parameters: unknown,
  strict: unknown,
) {
  return {
    type: "function",
    name,
    description,
    parameters: functionParameters(parameters),
    ...(typeof strict === "boolean" ? { strict } : {}),
  }
}

function combineDescriptions(namespaceDescription: string, toolDescription: string) {
  if (!namespaceDescription) return toolDescription
  if (!toolDescription) return namespaceDescription
  return `${namespaceDescription}\n\n${toolDescription}`
}

function compatibleResponsesTools(tools: unknown[], context: ToolContext) {
  const out: unknown[] = []
  const seenFunctionNames = new Set<string>()

  const pushTool = (tool: unknown) => {
    if (!isObject(tool) || tool.type !== "function") {
      out.push(tool)
      return
    }
    const name = safeTrim(tool.name || tool.function?.name)
    if (!name || seenFunctionNames.has(name)) return
    seenFunctionNames.add(name)
    out.push(tool)
  }

  for (const tool of tools) {
    rememberResponseTool(context, tool)
    if (!isObject(tool)) {
      pushTool(tool)
      continue
    }

    const type = safeTrim(tool.type)
    if (type === "tool_search") {
      context.toolSearchTools.add("tool_search")
      pushTool(
        responseFunctionTool(
          "tool_search",
          safeTrim(tool.description) ||
            "Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.",
          tool.parameters,
          tool.strict,
        ),
      )
      continue
    }

    if (type === "namespace") {
      const namespace = safeTrim(tool.name)
      const namespaceDescription = safeTrim(tool.description)
      const children = Array.isArray(tool.tools)
        ? tool.tools
        : Array.isArray(tool.children)
          ? tool.children
          : []
      for (const child of children) {
        if (!isObject(child) || child.type !== "function") continue
        const name = safeTrim(child.name)
        if (!name) continue
        pushTool(
          responseFunctionTool(
            flattenNamespaceToolName(namespace, name),
            combineDescriptions(namespaceDescription, safeTrim(child.description)),
            child.parameters,
            child.strict,
          ),
        )
      }
      continue
    }

    pushTool(tool)
  }
  return out
}

function compatibleToolChoice(choice: unknown, context: ToolContext): unknown {
  if (!isObject(choice)) return choice
  if (choice.type === "tool_search") {
    return context.toolSearchTools.has("tool_search")
      ? { type: "function", name: "tool_search" }
      : undefined
  }
  if (choice.type === "function") {
    const namespace = safeTrim(choice.namespace || choice.function?.namespace)
    const name = safeTrim(choice.name || choice.function?.name)
    if (!name) return undefined
    return {
      type: "function",
      name: namespace ? flattenNamespaceToolName(namespace, name) : name,
    }
  }
  if (Array.isArray(choice.tools)) {
    return {
      ...choice,
      tools: choice.tools
        .map((tool: unknown) => compatibleToolChoice(tool, context))
        .filter((tool: unknown) => tool != null),
    }
  }
  return choice
}

export function adaptToolSearchForCompatibleResponses(
  body: AnyRecord,
  context: ToolContext,
) {
  const declaredTools = Array.isArray(body.tools) ? body.tools : []
  const loadedTools = collectToolSearchOutputTools(body.input)
  body.tools = compatibleResponsesTools([...declaredTools, ...loadedTools], context)
  if (Array.isArray(body.input)) {
    body.input = body.input.map((item: unknown) =>
      isObject(item) ? compatibleToolSearchHistoryItem(item) || item : item,
    )
  } else if (isObject(body.input)) {
    body.input = compatibleToolSearchHistoryItem(body.input) || body.input
  }
  if (body.tool_choice != null) {
    const choice = compatibleToolChoice(body.tool_choice, context)
    if (choice == null) delete body.tool_choice
    else body.tool_choice = choice
  }
}

export function compatibleToolSearchHistoryItem(item: AnyRecord) {
  if (item.type === "tool_search_call") {
    const callId = callIdFromItem(item)
    return {
      type: "function_call",
      ...(callId ? { call_id: callId } : {}),
      name: "tool_search",
      arguments: functionArguments(item.arguments),
    }
  }
  if (item.type === "tool_search_output") {
    const callId = callIdFromItem(item)
    return {
      type: "function_call_output",
      ...(callId ? { call_id: callId } : {}),
      output: JSON.stringify(item),
    }
  }
  return undefined
}

export function compatibleResponsesFunctionProxyKind(
  name: string,
  context: ToolContext | undefined,
): CompatibleResponsesFunctionProxyKind | undefined {
  if (!context) return undefined
  if (context.customTools.has(name)) return "custom"
  if (context.toolSearchTools.has(name)) return "tool_search"
  if (context.functionTools.get(name)?.namespace) return "namespaced_function"
  return undefined
}

export function restoreCompatibleResponsesToolCalls(
  payload: unknown,
  context: ToolContext | undefined,
) {
  if (!context || !isObject(payload)) return payload
  const out = { ...payload }
  const wrapped = isObject(out.response)
  const root = wrapped ? { ...out.response } : out
  if (!Array.isArray(root.output)) return payload

  root.output = root.output.map((item: unknown) => {
    if (!isObject(item) || item.type !== "function_call") return item
    const name = safeTrim(item.name)
    const kind = compatibleResponsesFunctionProxyKind(name, context)
    if (kind !== "tool_search" && kind !== "namespaced_function") return item
    return toolCallItem(
      callIdFromItem(item),
      name,
      functionArguments(item.arguments),
      context,
      safeTrim(item.reasoning_content),
    )
  })

  if (wrapped) out.response = root
  return out
}
