import "server-only"

type AnyRecord = Record<string, any>

const ITEM_ID_PREFIX_BY_TYPE: Record<string, string> = {
  message: "msg_",
  reasoning: "rs_",
  function_call: "fc_",
  function_call_output: "fco_",
  custom_tool_call: "ctc_",
  custom_tool_call_output: "ctco_",
  tool_search_call: "tsc_",
  tool_search_output: "tso_",
  web_search_call: "ws_",
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function normalizedString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function safeItemIdSuffix(id: string) {
  const suffix = id.replace(/[^A-Za-z0-9_-]/g, "_")
  return suffix || "response_item"
}

export function normalizeResponsesItemId(type: unknown, value: unknown) {
  const itemType = normalizedString(type)
  const prefix = ITEM_ID_PREFIX_BY_TYPE[itemType]
  const id = normalizedString(value)
  if (!prefix || !id) return undefined
  if (id.startsWith(prefix)) return id
  if (id.startsWith("item_")) {
    return `${prefix}${safeItemIdSuffix(id.slice(5))}`
  }
  return `${prefix}${safeItemIdSuffix(id)}`
}

function repairItem(item: unknown) {
  if (!isObject(item)) return false
  const nextId = normalizeResponsesItemId(item.type, item.id)
  if (!nextId || nextId === item.id) return false
  item.id = nextId
  return true
}

export function repairResponsesItemIdsInBody(body: unknown) {
  if (!isObject(body) || !Array.isArray(body.input)) return body

  let changed = false
  const input = body.input.map((item: unknown) => {
    if (!isObject(item)) return item
    const next = { ...item }
    if (repairItem(next)) changed = true
    return next
  })
  if (!changed) return body
  return { ...body, input }
}

function repairResponseOutput(response: AnyRecord) {
  if (!Array.isArray(response.output)) return false
  return response.output.reduce(
    (changed: boolean, item: unknown) => repairItem(item) || changed,
    false,
  )
}

export function repairResponsesItemIdsInPayload(payload: unknown) {
  if (!isObject(payload)) return false
  const root = isObject(payload.response) ? payload.response : payload
  return repairResponseOutput(root)
}

function itemTypeForSseEvent(type: string) {
  if (
    type.startsWith("response.output_text.") ||
    type.startsWith("response.content_part.") ||
    type.startsWith("response.refusal.")
  ) {
    return "message"
  }
  if (type.startsWith("response.reasoning_")) return "reasoning"
  if (type.startsWith("response.function_call_arguments.")) return "function_call"
  if (type.startsWith("response.custom_tool_call_input.")) return "custom_tool_call"
  if (type.startsWith("response.tool_search_call.")) return "tool_search_call"
  if (type.startsWith("response.web_search_call.")) return "web_search_call"
  return undefined
}

export function repairResponsesItemIdsInSsePayload(
  payload: AnyRecord,
  eventName?: string,
) {
  const type = normalizedString(payload.type) || normalizedString(eventName)
  let changed = repairResponsesItemIdsInPayload(payload)

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    changed = repairItem(payload.item) || changed
  }

  const itemType = itemTypeForSseEvent(type)
  const nextItemId = normalizeResponsesItemId(itemType, payload.item_id)
  if (nextItemId && nextItemId !== payload.item_id) {
    payload.item_id = nextItemId
    changed = true
  }

  return changed
}
