import "server-only"

type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function normalizedId(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function safeMessageIdSuffix(id: string) {
  const suffix = id.replace(/[^A-Za-z0-9_-]/g, "_")
  return suffix || "response_message"
}

export function normalizeResponsesMessageId(value: unknown) {
  const id = normalizedId(value)
  if (!id) return undefined
  if (id.startsWith("msg_")) return id
  if (id.startsWith("item_")) return `msg_${safeMessageIdSuffix(id.slice(5))}`
  return `msg_${safeMessageIdSuffix(id)}`
}

function repairMessageItem(item: unknown) {
  if (!isObject(item) || item.type !== "message") return false
  const nextId = normalizeResponsesMessageId(item.id)
  if (!nextId || nextId === item.id) return false
  item.id = nextId
  return true
}

export function repairResponsesMessageIdsInBody(body: unknown) {
  if (!isObject(body) || !Array.isArray(body.input)) return body

  let changed = false
  const input = body.input.map((item: unknown) => {
    if (!isObject(item) || item.type !== "message") return item
    const next = { ...item }
    if (repairMessageItem(next)) changed = true
    return next
  })
  if (!changed) return body
  return { ...body, input }
}

function repairResponseOutput(response: AnyRecord) {
  if (!Array.isArray(response.output)) return false
  return response.output.reduce(
    (changed: boolean, item: unknown) => repairMessageItem(item) || changed,
    false,
  )
}

export function repairResponsesMessageIdsInPayload(payload: unknown) {
  if (!isObject(payload)) return false
  let changed = false
  const root = isObject(payload.response) ? payload.response : payload

  if (Array.isArray(root.output)) {
    changed = repairResponseOutput(root) || changed
  }
  return changed
}

export function repairResponsesMessageIdsInSsePayload(
  payload: AnyRecord,
  eventName?: string,
) {
  const type = normalizedId(payload.type) || normalizedId(eventName)
  let changed = false

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    changed = repairMessageItem(payload.item) || changed
  }

  if (type.startsWith("response.output_text.") || type.startsWith("response.content_part.")) {
    const nextId = normalizeResponsesMessageId(payload.item_id)
    if (nextId && nextId !== payload.item_id) {
      payload.item_id = nextId
      changed = true
    }
  }

  if (type === "response.completed" || type === "response.done") {
    if (isObject(payload.response)) {
      changed = repairResponsesMessageIdsInPayload(payload.response) || changed
    } else {
      changed = repairResponsesMessageIdsInPayload(payload) || changed
    }
  }

  return changed
}
