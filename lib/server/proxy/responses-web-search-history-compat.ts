import "server-only"

type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function idSuffix(value: string, fallback: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "_") || fallback
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => safeTrim(item)).filter(Boolean)
    : []
}

function argumentsForAction(action: unknown) {
  if (!isObject(action)) return "{}"
  if (action.type === "open_page") {
    const url = safeTrim(action.url)
    return JSON.stringify(url ? { url } : {})
  }
  const query = safeTrim(action.query)
  const queries = stringList(action.queries)
  const args: AnyRecord = {}
  if (query) args.query = query
  else if (queries.length > 0) args.query = queries[0]
  if (queries.length > 0) args.queries = queries
  return JSON.stringify(args)
}

function outputForAction(action: unknown) {
  const record = isObject(action) ? action : {}
  const actionType = safeTrim(record.type) || "search"
  if (record.type === "open_page") {
    const url = safeTrim(record.url)
    return JSON.stringify({ type: "open_page", ...(url ? { url } : {}), status: "completed" })
  }
  const query = safeTrim(record.query)
  const queries = stringList(record.queries)
  return JSON.stringify({
    type: actionType,
    ...(query ? { query } : {}),
    ...(queries.length > 0 ? { queries } : {}),
    status: "completed",
  })
}

function callIdForItem(item: AnyRecord, index: number) {
  const existing = safeTrim(item.call_id || item.callId)
  if (existing) return existing
  const itemId = safeTrim(item.id || item.item_id).replace(/^ws_/, "")
  return `call_${idSuffix(itemId, `web_search_${index}`)}`
}

function convertWebSearchCall(item: AnyRecord, index: number) {
  const callId = callIdForItem(item, index)
  const suffix = idSuffix(callId.replace(/^call_/, ""), `web_search_${index}`)
  // 部分 Responses 网关不接受历史里的 web_search_call，但接受与之等价的
  // function_call + function_call_output 配对，转换仅用于上行请求体。
  return [
    {
      type: "function_call",
      id: `fc_${suffix}`,
      call_id: callId,
      name: "web_search",
      arguments: argumentsForAction(item.action),
    },
    {
      type: "function_call_output",
      id: `fco_${suffix}`,
      call_id: callId,
      output: outputForAction(item.action),
    },
  ]
}

export function adaptWebSearchHistoryForRawResponsesPassthrough(body: unknown) {
  if (!isObject(body)) return body
  const input = body.input
  if (Array.isArray(input)) {
    const changed = input.some(
      (item) => isObject(item) && item.type === "web_search_call",
    )
    if (!changed) return body
    const nextInput = input.flatMap((item: unknown, index: number) =>
      isObject(item) && item.type === "web_search_call"
        ? convertWebSearchCall(item, index)
        : [item],
    )
    return { ...body, input: nextInput }
  }
  if (isObject(input) && input.type === "web_search_call") {
    return { ...body, input: convertWebSearchCall(input, 0) }
  }
  return body
}

