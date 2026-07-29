import "server-only"

import type { ProxyTarget } from "./common"
import {
  isHostedWebSearchToolType,
  RELAY_BROWSE_PAGE_TOOL_NAME,
  RELAY_WEB_SEARCH_TOOL_NAME,
  type RelayWebToolInput,
  type RelayWebToolName,
  type RelayWebToolResult,
} from "./web-search-relay"

type AnyRecord = Record<string, any>

export interface RelayWebToolCall {
  item: AnyRecord
  toolName: RelayWebToolName
  callId: string
  argumentsText: string
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function parsedArguments(value: unknown): AnyRecord {
  if (isObject(value)) return value
  if (typeof value !== "string" || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return isObject(parsed) ? parsed : { value: parsed }
  } catch {
    return { query: value }
  }
}

function inputItemsFromBody(body: AnyRecord) {
  if (Array.isArray(body.input)) return [...body.input]
  if (body.input == null) return []
  if (typeof body.input === "string") {
    return [{ type: "message", role: "user", content: body.input }]
  }
  return [body.input]
}

export function relaySessionIdFromBody(body: unknown, target: ProxyTarget) {
  if (!isObject(body)) return `${target.provider.id}:${target.modelId}`
  const metadata = isObject(body.metadata) ? body.metadata : {}
  const candidates = [
    body.prompt_cache_key,
    body.safety_identifier,
    metadata.thread_id,
    metadata.conversation_id,
    metadata.session_id,
  ]
  const configured = candidates
    .map((value) => String(value || "").trim())
    .find(Boolean)
  return configured || `${target.provider.id}:${target.modelId}`
}

export function relayInputFromCall(
  call: RelayWebToolCall,
  target: ProxyTarget,
  sessionId: string,
): RelayWebToolInput {
  const args = parsedArguments(call.item.arguments)
  if (call.toolName === RELAY_BROWSE_PAGE_TOOL_NAME) {
    return {
      toolName: call.toolName,
      argumentsValue: {
        ...args,
        ...(!args.url && call.item.action?.url ? { url: call.item.action.url } : {}),
      },
      sessionId,
      modelName: target.modelId,
    }
  }
  const query = String(
    call.item.action?.query ||
      args.query ||
      args.search_query ||
      args.q ||
      args.input ||
      "",
  ).trim()
  return {
    toolName: call.toolName,
    argumentsValue: { ...args, query },
    sessionId,
    modelName: target.modelId,
  }
}

export function extractRelayWebToolCalls(response: unknown): RelayWebToolCall[] {
  if (!isObject(response) || !Array.isArray(response.output)) return []
  return response.output
    .filter((item): item is AnyRecord => {
      if (!isObject(item)) return false
      if (item.type === "web_search_call") return true
      return (
        item.type === "function_call" &&
        (item.name === RELAY_WEB_SEARCH_TOOL_NAME ||
          item.name === RELAY_BROWSE_PAGE_TOOL_NAME)
      )
    })
    .map((item, index) => {
      const toolName: RelayWebToolName =
        item.type === "function_call" && item.name === RELAY_BROWSE_PAGE_TOOL_NAME
          ? RELAY_BROWSE_PAGE_TOOL_NAME
          : item.type === "web_search_call" && item.action?.type === "open_page"
            ? RELAY_BROWSE_PAGE_TOOL_NAME
            : RELAY_WEB_SEARCH_TOOL_NAME
      return {
        item,
        toolName,
        callId: String(item.call_id || item.id || `call_web_search_${index}`).trim(),
        argumentsText:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(
                item.arguments ||
                  (item.action?.type === "open_page"
                    ? { url: item.action?.url || "" }
                    : { query: item.action?.query || "" }),
              ),
      }
    })
}

function relayToolHistoryItems(
  calls: RelayWebToolCall[],
  results: Array<{ callId: string; output: string }>,
) {
  return calls.flatMap((call) => {
    const result = results.find((entry) => entry.callId === call.callId)
    return [
      {
        type: "function_call",
        call_id: call.callId,
        name: call.toolName,
        arguments: call.argumentsText || "{}",
      },
      {
        type: "function_call_output",
        call_id: call.callId,
        output: result?.output || "",
      },
    ]
  })
}

function responseAssistantHistoryItems(response: unknown) {
  if (!isObject(response) || !Array.isArray(response.output)) return []
  return response.output.filter(
    (item) => !(isObject(item) && (
      item.type === "web_search_call" ||
      (item.type === "function_call" && (
        item.name === RELAY_WEB_SEARCH_TOOL_NAME ||
        item.name === RELAY_BROWSE_PAGE_TOOL_NAME
      ))
    )),
  )
}

export function nextRelayBody(
  body: unknown,
  response: unknown,
  calls: RelayWebToolCall[],
  results: Array<{ callId: string; output: string }>,
) {
  if (!isObject(body)) return body
  const next: AnyRecord = {
    ...body,
    stream: false,
    input: [
      ...inputItemsFromBody(body),
      ...responseAssistantHistoryItems(response),
      ...relayToolHistoryItems(calls, results),
    ],
  }
  delete next.previous_response_id
  if (
    next.tool_choice === "required" ||
    isHostedWebSearchToolType(next.tool_choice) ||
    (isObject(next.tool_choice) && (
      isHostedWebSearchToolType(next.tool_choice.type) ||
      next.tool_choice.name === RELAY_WEB_SEARCH_TOOL_NAME ||
      next.tool_choice.name === RELAY_BROWSE_PAGE_TOOL_NAME ||
      next.tool_choice.function?.name === RELAY_WEB_SEARCH_TOOL_NAME ||
      next.tool_choice.function?.name === RELAY_BROWSE_PAGE_TOOL_NAME
    ))
  ) {
    next.tool_choice = "auto"
  }
  return next
}

export function mergeRelayOutputItems(response: unknown, items: AnyRecord[]) {
  if (!items.length || !isObject(response)) return response
  const output = Array.isArray(response.output) ? response.output : []
  const existing = new Set(
    output
      .filter((item) => isObject(item))
      .map((item) => String(item.id || item.call_id || "")),
  )
  return {
    ...response,
    output: [
      ...items.filter((item) => !existing.has(String(item.id || item.call_id || ""))),
      ...output,
    ],
  }
}

export function relayDisplayItem(call: RelayWebToolCall, result: RelayWebToolResult) {
  if (result.toolName === RELAY_BROWSE_PAGE_TOOL_NAME) {
    const urls = (result.browse?.pages || [])
      .map((page) => String(page.url || "").trim())
      .filter(Boolean)
    return {
      id: `ws_${call.callId}`,
      type: "web_search_call",
      status: "completed",
      call_id: call.callId,
      arguments: call.argumentsText,
      action: {
        type: "open_page",
        url: urls[0] || "",
        ...(urls.length > 1 ? { urls } : {}),
      },
    }
  }
  return {
    id: `ws_${call.callId}`,
    type: "web_search_call",
    status: "completed",
    call_id: call.callId,
    arguments: call.argumentsText,
    action: {
      type: "search",
      query: result.search?.query || "",
      provider: result.search?.provider,
    },
  }
}
