import "server-only"

type AnyRecord = Record<string, any>

const textEncoder = new TextEncoder()
const COLLAB_TOOL_NAMES = new Set([
  "spawn_agent",
  "send_input",
  "wait_agent",
  "resume_agent",
  "close_agent",
])
const COLLAB_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function responsePayloadRoot(value: any) {
  return isObject(value?.response) ? value.response : value
}

export function parseSseFrames(text: string) {
  const frames: Array<{ event: string; data?: any; raw?: string; done?: boolean }> = []
  for (const rawFrame of String(text || "").trimStart().replace(/^\uFEFF/, "").split(/\r?\n\r?\n/)) {
    const lines = rawFrame.split(/\r?\n/)
    let event = ""
    const data: string[] = []
    for (const rawLine of lines) {
      const line = rawLine.trimStart()
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
    }
    if (data.length === 0) continue
    const payload = data.join("\n")
    if (payload === "[DONE]") {
      frames.push({ event, done: true })
      continue
    }
    try {
      frames.push({ event, data: JSON.parse(payload) })
    } catch {
      frames.push({ event, raw: payload })
    }
  }
  return frames
}

function sse(event: string, payload: unknown) {
  const prefix = event ? `event: ${event}\n` : ""
  return `${prefix}data: ${
    typeof payload === "string" ? payload : JSON.stringify(payload)
  }\n\n`
}

function rawSseFrame(frameText: string) {
  return `${frameText}\n\n`
}

function splitSseFrame(text: string) {
  const crlf = text.indexOf("\r\n\r\n")
  const lf = text.indexOf("\n\n")
  if (crlf < 0 && lf < 0) return null
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    return { index: crlf, separatorLength: 4 }
  }
  return { index: lf, separatorLength: 2 }
}

function parseSseFrame(frameText: string) {
  let event = ""
  const data: string[] = []
  for (const rawLine of String(frameText || "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith("event:")) {
      const value = line.slice(6).trim()
      if (value) event = value
    } else if (line.startsWith("data:")) {
      const value = line.slice(5).trimStart()
      if (value) data.push(value)
    }
  }
  return {
    event,
    payload: data.length > 0 ? data.join("\n") : String(frameText || "").trim(),
  }
}

export function extractResponseId(value: any) {
  const root = responsePayloadRoot(value)
  if (typeof root?.id === "string") return root.id
  if (typeof value?.response_id === "string") return value.response_id
  if (typeof value?.id === "string" && value.id.startsWith("resp_")) return value.id
  return ""
}

export function extractUsage(value: any) {
  const root = responsePayloadRoot(value)
  return root?.usage || value?.usage || null
}

function isCollabToolName(name: unknown) {
  return COLLAB_TOOL_NAMES.has(String(name || ""))
}

function isMeaningfulInputItem(value: unknown) {
  if (!isObject(value)) return false
  for (const key of ["text", "image_url", "imageUrl", "path", "name"]) {
    if (typeof value[key] === "string" && value[key].trim()) return true
  }
  for (const key of ["file", "file_data", "file_id", "data"]) {
    if (value[key] != null) return true
  }
  return false
}

function textOnlyItems(items: unknown[]) {
  const texts: string[] = []
  for (const item of items) {
    if (!isObject(item)) return null
    if (typeof item.type === "string" && item.type !== "text") return null
    const text = typeof item.text === "string" ? item.text.trim() : ""
    if (!text) return null
    texts.push(text)
  }
  return texts.join("\n\n").trim()
}

function sanitizeCollabToolArguments(name: unknown, raw: unknown) {
  if (!isCollabToolName(name) || !String(raw || "").trim()) return null
  let parsed: AnyRecord
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    return null
  }
  if (!isObject(parsed)) return null

  const args = { ...parsed }
  const messageText =
    typeof args.message === "string" && args.message.trim() ? args.message.trim() : null
  if (!messageText) delete args.message

  const meaningfulItems = Array.isArray(args.items)
    ? args.items.filter(isMeaningfulInputItem)
    : null
  if (meaningfulItems?.length) args.items = meaningfulItems
  else delete args.items

  if (Object.hasOwn(args, "message") && Object.hasOwn(args, "items")) {
    const itemText = textOnlyItems(args.items)
    if (itemText === messageText) delete args.items
    else delete args.message
  }

  for (const key of ["model", "service_tier", "agent_type"]) {
    if (typeof args[key] !== "string" || !args[key].trim()) delete args[key]
  }

  const effort =
    typeof args.reasoning_effort === "string"
      ? args.reasoning_effort.trim().toLowerCase()
      : ""
  if (COLLAB_REASONING_EFFORTS.has(effort)) args.reasoning_effort = effort
  else delete args.reasoning_effort

  return JSON.stringify(args)
}

function repairFunctionCallArguments(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) return raw
  try {
    JSON.parse(raw)
    return raw
  } catch {
    // Some shims prepend "{}" before the real function arguments.
  }
  const match = raw.match(/^\s*\{\s*\}\s*([\s\S]+)$/)
  if (!match) return raw
  const suffix = match[1].trimStart()
  try {
    JSON.parse(suffix)
    return suffix
  } catch {
    return raw
  }
}

function stableFunctionCallId(item: AnyRecord) {
  const existing = String(item.call_id || item.callId || "").trim()
  if (existing) return existing
  const id = String(item.id || "").trim()
  return id ? (id.startsWith("call_") ? id : `call_${id.replace(/[^A-Za-z0-9_-]/g, "_")}`) : ""
}

function ensureFunctionCallId(item: AnyRecord) {
  if (!isObject(item) || item.type !== "function_call") return false
  const callId = stableFunctionCallId(item)
  if (!callId || item.call_id === callId) return false
  item.call_id = callId
  delete item.callId
  return true
}

function functionItemKeys(item: AnyRecord) {
  const keys: string[] = []
  for (const value of [item?.id, item?.call_id]) {
    const key = String(value || "").trim()
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

function sanitizeResponseOutputArguments(response: AnyRecord) {
  if (!Array.isArray(response?.output)) return
  for (const item of response.output) {
    if (!isObject(item) || item.type !== "function_call") continue
    ensureFunctionCallId(item)
    if (typeof item.arguments === "string") {
      item.arguments = repairFunctionCallArguments(item.arguments)
    }
    const sanitized = sanitizeCollabToolArguments(item.name, item.arguments || "")
    if (sanitized != null) item.arguments = sanitized
  }
}

class ResponsesStreamRepairer {
  private buffer = ""
  private decoder = new TextDecoder()
  private pending = new Map<string, any>()
  private functionItems = new Map<string, any>()
  private messageItems = new Map<string, any>()
  private reasoningItems = new Map<string, any>()
  private customToolItems = new Map<string, any>()
  private outputItemDoneKeys = new Set<string>()
  private outputKeyByIndex = new Map<string, string>()
  private lastMessageKey = ""
  private lastReasoningKey = ""
  private lastCustomToolKey = ""
  private responseModel = ""
  private completedSeen = false
  private failedSeen = false
  private pendingDone = false
  responseId = ""
  usage: any = null

  constructor(
    private options: {
      modelOverride?: string
      repairIncompleteFinalItems?: boolean
      synthesizeFinalOnStreamEnd?: boolean
    } = {},
  ) {}

  feed(chunk: Uint8Array) {
    if (!chunk.length) return ""
    this.buffer += this.decoder.decode(chunk, { stream: true })
    return this.process(false)
  }

  finish() {
    this.buffer += this.decoder.decode()
    const processed = this.process(true)
    const terminal = this.synthesizeTerminalIfNeeded()
    return processed + terminal
  }

  private process(flushTail: boolean) {
    let out = ""
    while (true) {
      const boundary = splitSseFrame(this.buffer)
      if (!boundary) break
      const frameText = this.buffer.slice(0, boundary.index)
      this.buffer = this.buffer.slice(boundary.index + boundary.separatorLength)
      out += this.processFrame(frameText)
    }
    if (flushTail && this.buffer.trim()) {
      const frameText = this.buffer
      this.buffer = ""
      out += this.processFrame(frameText)
    }
    return out
  }

  private processFrame(frameText: string) {
    if (!frameText.trim()) return ""
    const { event, payload } = parseSseFrame(frameText)
    if (payload === "[DONE]") {
      if (this.options.synthesizeFinalOnStreamEnd && !this.completedSeen && !this.failedSeen) {
        this.pendingDone = true
        return ""
      }
      return rawSseFrame(frameText)
    }
    let data: AnyRecord
    try {
      data = JSON.parse(payload)
    } catch {
      return rawSseFrame(frameText)
    }

    const id = extractResponseId(data)
    if (id && !this.responseId) this.responseId = id
    const usage = extractUsage(data)
    if (usage) this.usage = usage
    const modelChanged = this.applyModelOverride(data)
    const model = this.extractModel(data)
    if (model) this.responseModel = model

    const type = data.type || event
    if (type === "response.output_item.added") {
      return this.handleOutputItemAdded(event, data, frameText)
    }
    if (type === "response.output_text.delta") {
      this.rememberTextDelta("message", data, data.delta)
      return modelChanged ? sse(event, data) : rawSseFrame(frameText)
    }
    if (type === "response.output_text.done" || type === "response.content_part.done") {
      const text =
        typeof data.text === "string"
          ? data.text
          : data.part?.type === "output_text" && typeof data.part.text === "string"
            ? data.part.text
            : ""
      this.rememberTextDone("message", data, text)
      return modelChanged ? sse(event, data) : rawSseFrame(frameText)
    }
    if (type === "response.reasoning_summary_text.delta") {
      this.rememberTextDelta("reasoning", data, data.delta)
      return modelChanged ? sse(event, data) : rawSseFrame(frameText)
    }
    if (type === "response.reasoning_summary_text.done" || type === "response.reasoning_summary_part.done") {
      const text =
        typeof data.text === "string"
          ? data.text
          : data.part?.type === "summary_text" && typeof data.part.text === "string"
            ? data.part.text
            : ""
      this.rememberTextDone("reasoning", data, text)
      return modelChanged ? sse(event, data) : rawSseFrame(frameText)
    }
    if (type === "response.custom_tool_call_input.delta") {
      this.rememberTextDelta("custom_tool", data, data.delta)
      return modelChanged ? sse(event, data) : rawSseFrame(frameText)
    }
    if (type === "response.custom_tool_call_input.done") {
      const input =
        typeof data.input === "string"
          ? data.input
          : typeof data.text === "string"
            ? data.text
            : ""
      this.rememberTextDone("custom_tool", data, input)
      return modelChanged ? sse(event, data) : rawSseFrame(frameText)
    }
    if (type === "response.function_call_arguments.delta") {
      return this.handleFunctionArgumentsDelta(event, data, frameText)
    }
    if (type === "response.function_call_arguments.done") {
      return this.handleFunctionArgumentsDone(event, data, frameText)
    }
    if (type === "response.output_item.done") {
      return this.handleOutputItemDone(event, data, frameText)
    }
    if (type === "response.completed" || type === "response.done") {
      this.completedSeen = true
      this.pendingDone = false
      let prefix = ""
      for (const itemId of Array.from(this.pending.keys())) prefix += this.flushArgs(itemId)
      const response = isObject(data.response) ? data.response : data
      sanitizeResponseOutputArguments(response)
      if (this.options.repairIncompleteFinalItems !== false) {
        this.repairCompletedResponseItems(response)
      }
      return prefix + sse(event, data)
    }
    if (type === "response.failed") {
      this.failedSeen = true
      this.pendingDone = false
      return modelChanged ? sse(event, data) : rawSseFrame(frameText)
    }
    return modelChanged ? sse(event, data) : rawSseFrame(frameText)
  }

  private applyModelOverride(data: AnyRecord) {
    const modelOverride = this.options.modelOverride?.trim()
    if (!modelOverride) return false
    let changed = false
    if (typeof data.model === "string") {
      data.model = modelOverride
      changed = true
    }
    if (isObject(data.response) && typeof data.response.model === "string") {
      data.response.model = modelOverride
      changed = true
    }
    return changed
  }

  private extractModel(data: AnyRecord) {
    const response = isObject(data.response) ? data.response : data
    if (typeof response.model === "string" && response.model.trim()) return response.model.trim()
    if (typeof data.model === "string" && data.model.trim()) return data.model.trim()
    return ""
  }

  private handleOutputItemAdded(event: string, data: AnyRecord, frameText: string) {
    const item = data.item
    if (isObject(item) && item.type === "message") {
      this.rememberOutputItem("message", item, data.output_index)
      return rawSseFrame(frameText)
    }
    if (isObject(item) && item.type === "reasoning") {
      this.rememberOutputItem("reasoning", item, data.output_index)
      return rawSseFrame(frameText)
    }
    if (isObject(item) && item.type === "custom_tool_call") {
      this.rememberOutputItem("custom_tool", item, data.output_index)
      return rawSseFrame(frameText)
    }
    if (!isObject(item) || item.type !== "function_call") return rawSseFrame(frameText)

    const callIdChanged = ensureFunctionCallId(item)
    const itemId = String(item.id || item.call_id || "").trim()
    const name = String(item.name || "").trim()
    const argumentsText = typeof item.arguments === "string" ? item.arguments : ""
    if (itemId) {
      const snapshot = {
        id: itemId,
        callId: item.call_id || "",
        name,
        outputIndex: data.output_index,
        chunks: argumentsText ? [argumentsText] : [],
      }
      for (const key of functionItemKeys(item)) this.functionItems.set(key, snapshot)
    }
    if (!itemId || !isCollabToolName(name)) {
      const repaired = repairFunctionCallArguments(argumentsText)
      if (repaired !== argumentsText) {
        item.arguments = repaired
        return sse(event, data)
      }
      return callIdChanged ? sse(event, data) : rawSseFrame(frameText)
    }
    this.pending.set(itemId, {
      name,
      outputIndex: data.output_index,
      chunks: argumentsText ? [argumentsText] : [],
      flushed: false,
      sanitized: null,
    })
    if (argumentsText) {
      item.arguments = ""
      return sse(event, data)
    }
    return callIdChanged ? sse(event, data) : rawSseFrame(frameText)
  }

  private handleFunctionArgumentsDelta(event: string, data: AnyRecord, frameText: string) {
    const itemId = String(data.item_id || "").trim()
    if (itemId && typeof data.delta === "string") {
      const snapshot = this.functionItems.get(itemId)
      if (snapshot) snapshot.chunks.push(data.delta)
    }
    const item = this.pending.get(itemId)
    if (!item) {
      if (typeof data.delta === "string") {
        const repaired = repairFunctionCallArguments(data.delta)
        if (repaired !== data.delta) {
          data.delta = repaired
          return sse(event, data)
        }
      }
      return rawSseFrame(frameText)
    }
    if (typeof data.delta === "string") item.chunks.push(data.delta)
    if (Object.hasOwn(data, "output_index")) item.outputIndex = data.output_index
    return ""
  }

  private handleFunctionArgumentsDone(event: string, data: AnyRecord, frameText: string) {
    const itemId = String(data.item_id || "").trim()
    if (itemId && typeof data.arguments === "string" && data.arguments) {
      const snapshot = this.functionItems.get(itemId)
      if (snapshot && snapshot.chunks.length === 0) snapshot.chunks.push(data.arguments)
    }
    const item = this.pending.get(itemId)
    if (!item) {
      if (typeof data.arguments === "string") {
        const repaired = repairFunctionCallArguments(data.arguments)
        if (repaired !== data.arguments) {
          data.arguments = repaired
          return sse(event, data)
        }
      }
      return rawSseFrame(frameText)
    }
    if (typeof data.arguments === "string" && data.arguments && item.chunks.length === 0) {
      item.chunks.push(data.arguments)
    }
    const { prefix, sanitized } = this.flushArgsWithPrefix(itemId)
    data.arguments = sanitized
    return prefix + sse(event, data)
  }

  private handleOutputItemDone(event: string, data: AnyRecord, frameText: string) {
    const item = data.item
    if (isObject(item) && item.type === "message") {
      this.rememberOutputItem("message", item, data.output_index)
      this.markOutputItemDone("message", item, data.output_index)
      return this.repairMessageItem(item, data.output_index)
        ? sse(event, data)
        : rawSseFrame(frameText)
    }
    if (isObject(item) && item.type === "reasoning") {
      this.rememberOutputItem("reasoning", item, data.output_index)
      this.markOutputItemDone("reasoning", item, data.output_index)
      return this.repairReasoningItem(item, data.output_index)
        ? sse(event, data)
        : rawSseFrame(frameText)
    }
    if (isObject(item) && item.type === "custom_tool_call") {
      this.rememberOutputItem("custom_tool", item, data.output_index)
      this.markOutputItemDone("custom_tool", item, data.output_index)
      return this.repairCustomToolItem(item, data.output_index)
        ? sse(event, data)
        : rawSseFrame(frameText)
    }
    if (!isObject(item)) return rawSseFrame(frameText)

    const itemId = String(item.id || item.call_id || "").trim()
    const pending = this.pending.get(itemId)
    let changed = this.repairFunctionItem(item, data.output_index)
    this.markOutputItemDone("function_call", item, data.output_index)
    if (!pending) return changed ? sse(event, data) : rawSseFrame(frameText)

    if (typeof item.arguments === "string" && item.arguments && pending.chunks.length === 0) {
      pending.chunks.push(item.arguments)
    }
    const { prefix, sanitized } = this.flushArgsWithPrefix(itemId)
    ensureFunctionCallId(item)
    item.arguments = sanitized
    changed = true
    return prefix + (changed ? sse(event, data) : rawSseFrame(frameText))
  }

  private flushArgsWithPrefix(itemId: string) {
    const item = this.pending.get(itemId)
    if (!item) return { prefix: "", sanitized: "" }
    if (item.flushed) return { prefix: "", sanitized: item.sanitized || "" }
    item.flushed = true
    const raw = repairFunctionCallArguments(item.chunks.join(""))
    const sanitized = sanitizeCollabToolArguments(item.name, raw) ?? raw
    item.sanitized = sanitized
    if (!sanitized) return { prefix: "", sanitized }
    const payload: AnyRecord = {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      delta: sanitized,
    }
    if (item.outputIndex != null) payload.output_index = item.outputIndex
    return { prefix: sse("response.function_call_arguments.delta", payload), sanitized }
  }

  private flushArgs(itemId: string) {
    return this.flushArgsWithPrefix(itemId).prefix
  }

  private outputItemDoneKeyValues(
    kind: "message" | "reasoning" | "custom_tool" | "function_call",
    item: AnyRecord,
    outputIndex: unknown,
  ) {
    const keys = new Set<string>()
    const add = (value: unknown) => {
      const text = String(value || "").trim()
      if (text) keys.add(`${kind}:${text}`)
    }
    if (kind === "function_call") {
      for (const key of functionItemKeys(item)) add(key)
    } else {
      add(item?.id)
    }
    if (outputIndex != null) add(`index:${outputIndex}`)
    return Array.from(keys)
  }

  private markOutputItemDone(
    kind: "message" | "reasoning" | "custom_tool" | "function_call",
    item: AnyRecord,
    outputIndex: unknown,
  ) {
    for (const key of this.outputItemDoneKeyValues(kind, item, outputIndex)) {
      this.outputItemDoneKeys.add(key)
    }
  }

  private hasOutputItemDone(
    kind: "message" | "reasoning" | "custom_tool" | "function_call",
    item: AnyRecord,
    outputIndex: unknown,
  ) {
    return this.outputItemDoneKeyValues(kind, item, outputIndex).some((key) =>
      this.outputItemDoneKeys.has(key),
    )
  }

  private outputKeyFor(kind: "message" | "reasoning" | "custom_tool", item: AnyRecord, outputIndex: unknown) {
    const id = String(item?.id || "").trim()
    return id || (outputIndex != null ? `${kind}:${outputIndex}` : "")
  }

  private storeForKind(kind: "message" | "reasoning" | "custom_tool") {
    if (kind === "reasoning") return this.reasoningItems
    if (kind === "custom_tool") return this.customToolItems
    return this.messageItems
  }

  private ensureOutputSnapshot(kind: "message" | "reasoning" | "custom_tool", key: string, outputIndex: unknown) {
    const store = this.storeForKind(kind)
    let snapshot = store.get(key)
    if (!snapshot) {
      snapshot = { key, kind, item: null, outputIndex, chunks: [], doneText: "" }
      store.set(key, snapshot)
    }
    if (outputIndex != null) {
      snapshot.outputIndex = outputIndex
      this.outputKeyByIndex.set(`${kind}:${outputIndex}`, key)
    }
    return snapshot
  }

  private rememberOutputItem(kind: "message" | "reasoning" | "custom_tool", item: AnyRecord, outputIndex: unknown) {
    const key = this.outputKeyFor(kind, item, outputIndex)
    if (!key) return null
    const snapshot = this.ensureOutputSnapshot(kind, key, outputIndex)
    snapshot.item = { ...item }
    const embeddedText = this.embeddedOutputText(kind, item)
    if (embeddedText) snapshot.doneText = embeddedText
    if (kind === "message") this.lastMessageKey = key
    else if (kind === "reasoning") this.lastReasoningKey = key
    else this.lastCustomToolKey = key
    return snapshot
  }

  private embeddedOutputText(kind: "message" | "reasoning" | "custom_tool", item: AnyRecord) {
    if (kind === "message" && Array.isArray(item.content)) {
      const part = item.content.find(
        (entry: AnyRecord) => entry?.type === "output_text" && typeof entry.text === "string",
      )
      return typeof part?.text === "string" ? part.text : ""
    }
    if (kind === "reasoning") {
      if (typeof item.reasoning_content === "string" && item.reasoning_content) return item.reasoning_content
      if (Array.isArray(item.summary)) {
        const part = item.summary.find(
          (entry: AnyRecord) => entry?.type === "summary_text" && typeof entry.text === "string",
        )
        return typeof part?.text === "string" ? part.text : ""
      }
    }
    if (kind === "custom_tool" && typeof item.input === "string") return item.input
    return ""
  }

  private resolveOutputKey(kind: "message" | "reasoning" | "custom_tool", data: AnyRecord) {
    const itemId = String(data?.item_id || data?.itemId || "").trim()
    if (itemId) return itemId
    if (data?.output_index != null) {
      return this.outputKeyByIndex.get(`${kind}:${data.output_index}`) || `${kind}:${data.output_index}`
    }
    if (kind === "reasoning") return this.lastReasoningKey
    if (kind === "custom_tool") return this.lastCustomToolKey
    return this.lastMessageKey
  }

  private rememberTextDelta(kind: "message" | "reasoning" | "custom_tool", data: AnyRecord, text: unknown) {
    if (typeof text !== "string" || !text) return
    const key = this.resolveOutputKey(kind, data)
    if (!key) return
    const snapshot = this.ensureOutputSnapshot(kind, key, data.output_index)
    snapshot.chunks.push(text)
    if (kind === "reasoning") this.lastReasoningKey = key
    else if (kind === "custom_tool") this.lastCustomToolKey = key
    else this.lastMessageKey = key
  }

  private rememberTextDone(kind: "message" | "reasoning" | "custom_tool", data: AnyRecord, text: string) {
    if (!text) return
    const key = this.resolveOutputKey(kind, data)
    if (!key) return
    const snapshot = this.ensureOutputSnapshot(kind, key, data.output_index)
    snapshot.doneText = text
  }

  private snapshotText(snapshot: any) {
    return snapshot ? snapshot.doneText || snapshot.chunks.join("") : ""
  }

  private repairMessageItem(item: AnyRecord, outputIndex: unknown) {
    const key = this.outputKeyFor("message", item, outputIndex) || this.resolveOutputKey("message", { output_index: outputIndex })
    const text = this.snapshotText(this.messageItems.get(key))
    if (!text || item.content?.some?.((part: AnyRecord) => part?.type === "output_text" && part.text)) return false
    item.role ||= "assistant"
    item.content = [{ type: "output_text", text }]
    return true
  }

  private repairReasoningItem(item: AnyRecord, outputIndex: unknown) {
    const key = this.outputKeyFor("reasoning", item, outputIndex) || this.resolveOutputKey("reasoning", { output_index: outputIndex })
    const text = this.snapshotText(this.reasoningItems.get(key))
    if (!text) return false
    let changed = false
    if (!String(item.reasoning_content || "").trim()) {
      item.reasoning_content = text
      changed = true
    }
    if (!item.summary?.some?.((part: AnyRecord) => part?.type === "summary_text" && part.text)) {
      item.summary = [{ type: "summary_text", text }]
      changed = true
    }
    return changed
  }

  private repairCustomToolItem(item: AnyRecord, outputIndex: unknown) {
    const key = this.outputKeyFor("custom_tool", item, outputIndex) || this.resolveOutputKey("custom_tool", { output_index: outputIndex })
    const input = this.snapshotText(this.customToolItems.get(key))
    let changed = false
    if (input && !String(item.input || "").trim()) {
      item.input = input
      changed = true
    }
    if (item.status === "in_progress") {
      item.status = "completed"
      changed = true
    }
    return changed
  }

  private functionSnapshotArgs(snapshot: any) {
    const raw = repairFunctionCallArguments((snapshot?.chunks || []).join(""))
    return sanitizeCollabToolArguments(snapshot?.name, raw) ?? raw
  }

  private repairFunctionItem(item: AnyRecord, outputIndex: unknown) {
    const snapshot =
      functionItemKeys(item).map((key) => this.functionItems.get(key)).find(Boolean) ||
      (outputIndex != null
        ? Array.from(new Set(this.functionItems.values())).find((entry: any) => entry.outputIndex === outputIndex)
        : null)
    if (!snapshot) return false
    let changed = false
    if (!String(item.id || "").trim() && snapshot.id) {
      item.id = snapshot.id
      changed = true
    }
    if (!String(item.call_id || "").trim() && snapshot.callId) {
      item.call_id = snapshot.callId
      changed = true
    }
    if (!String(item.name || "").trim() && snapshot.name) {
      item.name = snapshot.name
      changed = true
    }
    const currentArguments = typeof item.arguments === "string" ? item.arguments : ""
    const args = this.functionSnapshotArgs(snapshot)
    if (!currentArguments && args) {
      item.arguments = args
      changed = true
    } else if (currentArguments) {
      const repaired = repairFunctionCallArguments(currentArguments)
      const sanitized = sanitizeCollabToolArguments(item.name || snapshot.name, repaired) ?? repaired
      if (sanitized !== currentArguments) {
        item.arguments = sanitized
        changed = true
      }
    }
    return ensureFunctionCallId(item) || changed
  }

  private buildMessageItem(snapshot: any) {
    const text = this.snapshotText(snapshot)
    if (!text) return null
    return {
      ...(snapshot.item || {}),
      type: "message",
      role: snapshot.item?.role || "assistant",
      content: [{ type: "output_text", text }],
    }
  }

  private buildReasoningItem(snapshot: any) {
    const text = this.snapshotText(snapshot)
    if (!text) return null
    return {
      ...(snapshot.item || {}),
      type: "reasoning",
      reasoning_content: text,
      summary: [{ type: "summary_text", text }],
    }
  }

  private buildCustomToolItem(snapshot: any) {
    if (!snapshot?.item) return null
    const input = this.snapshotText(snapshot)
    const item = {
      ...(snapshot.item || {}),
      type: "custom_tool_call",
    }
    if (input && !String(item.input || "").trim()) item.input = input
    if (item.status === "in_progress") item.status = "completed"
    return item
  }

  private buildFunctionItem(snapshot: any) {
    if (!snapshot?.name) return null
    const item = {
      id: snapshot.id || snapshot.callId,
      type: "function_call",
      call_id: snapshot.callId || snapshot.id,
      name: snapshot.name,
      arguments: this.functionSnapshotArgs(snapshot),
      status: "completed",
    }
    ensureFunctionCallId(item)
    return item
  }

  private repairCompletedResponseItems(response: AnyRecord) {
    const output = Array.isArray(response.output) ? response.output : []
    const includedMessageKeys = new Set<string>()
    const includedReasoningKeys = new Set<string>()
    const includedCustomToolKeys = new Set<string>()
    const includedFunctionKeys = new Set<string>()
    for (let index = 0; index < output.length; index += 1) {
      const item = output[index]
      if (item?.type === "message") {
        const key = this.outputKeyFor("message", item, index)
        if (key) includedMessageKeys.add(key)
        this.repairMessageItem(item, index)
      } else if (item?.type === "reasoning") {
        const key = this.outputKeyFor("reasoning", item, index)
        if (key) includedReasoningKeys.add(key)
        this.repairReasoningItem(item, index)
      } else if (item?.type === "custom_tool_call") {
        const key = this.outputKeyFor("custom_tool", item, index)
        if (key) includedCustomToolKeys.add(key)
        this.repairCustomToolItem(item, index)
      } else if (item?.type === "function_call") {
        this.repairFunctionItem(item, index)
        for (const key of functionItemKeys(item)) includedFunctionKeys.add(key)
      }
    }

    const missing: Array<{ outputIndex: unknown; item: AnyRecord }> = []
    for (const snapshot of this.reasoningItems.values()) {
      if (!includedReasoningKeys.has(snapshot.key)) {
        const item = this.buildReasoningItem(snapshot)
        if (item) missing.push({ outputIndex: snapshot.outputIndex, item })
      }
    }
    for (const snapshot of this.messageItems.values()) {
      if (!includedMessageKeys.has(snapshot.key)) {
        const item = this.buildMessageItem(snapshot)
        if (item) missing.push({ outputIndex: snapshot.outputIndex, item })
      }
    }
    for (const snapshot of this.customToolItems.values()) {
      if (!includedCustomToolKeys.has(snapshot.key)) {
        const item = this.buildCustomToolItem(snapshot)
        if (item) missing.push({ outputIndex: snapshot.outputIndex, item })
      }
    }
    for (const snapshot of new Set(this.functionItems.values())) {
      const key = String(snapshot?.id || snapshot?.callId || "").trim()
      if (!key || includedFunctionKeys.has(key)) continue
      const item = this.buildFunctionItem(snapshot)
      if (item) missing.push({ outputIndex: snapshot.outputIndex, item })
    }

    const nextOutput = [...output]
    for (const entry of missing.sort((a, b) => Number(a.outputIndex ?? 999999) - Number(b.outputIndex ?? 999999))) {
      const index = Number.isFinite(Number(entry.outputIndex))
        ? Math.max(0, Math.min(nextOutput.length, Number(entry.outputIndex)))
        : nextOutput.length
      nextOutput.splice(index, 0, entry.item)
    }
    response.output = nextOutput

    const outputText = Array.from(this.messageItems.values())
      .map((snapshot) => this.snapshotText(snapshot))
      .join("")
    if (outputText && !response.output_text) response.output_text = outputText
  }

  private syntheticResponseBase(status: "completed" | "failed") {
    const model = this.options.modelOverride?.trim() || this.responseModel || "codex"
    const response: AnyRecord = {
      id: this.responseId || `resp_${Date.now()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model,
      status,
      output: [],
    }
    if (this.usage) response.usage = this.usage
    return response
  }

  private syntheticDoneSuffix() {
    if (!this.pendingDone) return ""
    this.pendingDone = false
    return "data: [DONE]\n\n"
  }

  private outputItemKindForSyntheticDone(item: AnyRecord) {
    if (item.type === "message") return "message"
    if (item.type === "reasoning") return "reasoning"
    if (item.type === "custom_tool_call") return "custom_tool"
    if (item.type === "function_call") return "function_call"
    return ""
  }

  private synthesizeMissingOutputItemDoneFrames(response: AnyRecord) {
    if (!Array.isArray(response.output)) return ""
    let out = ""
    response.output.forEach((item: unknown, index: number) => {
      if (!isObject(item)) return
      const kind = this.outputItemKindForSyntheticDone(item)
      if (!kind) return
      const typedKind = kind as "message" | "reasoning" | "custom_tool" | "function_call"
      if (this.hasOutputItemDone(typedKind, item, index)) return
      this.markOutputItemDone(typedKind, item, index)
      out += sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: index,
        item,
      })
    })
    return out
  }

  private synthesizeTerminalIfNeeded() {
    if (!this.options.synthesizeFinalOnStreamEnd) return ""
    if (this.completedSeen || this.failedSeen) return this.syntheticDoneSuffix()

    let prefix = ""
    for (const itemId of Array.from(this.pending.keys())) prefix += this.flushArgs(itemId)

    const response = this.syntheticResponseBase("completed")
    this.repairCompletedResponseItems(response)
    sanitizeResponseOutputArguments(response)

    const hasOutput =
      Array.isArray(response.output) && response.output.length > 0 ||
      typeof response.output_text === "string" && response.output_text.trim().length > 0
    if (hasOutput) {
      this.completedSeen = true
      return (
        prefix +
        this.synthesizeMissingOutputItemDoneFrames(response) +
        sse("response.completed", { type: "response.completed", response }) +
        this.syntheticDoneSuffix()
      )
    }

    const failed = this.syntheticResponseBase("failed")
    failed.error = {
      code: "stream_truncated",
      message: "Upstream stream ended before response.completed",
    }
    this.failedSeen = true
    return sse("response.failed", { type: "response.failed", response: failed }) + this.syntheticDoneSuffix()
  }
}

export function transformResponsesSseText(
  text: string,
  options: {
    modelOverride?: string
    repairIncompleteFinalItems?: boolean
    synthesizeFinalOnStreamEnd?: boolean
  } = {},
) {
  const transformer = new ResponsesStreamRepairer(options)
  const body = transformer.feed(textEncoder.encode(String(text || "")))
  const tail = transformer.finish()
  return { text: body + tail, responseId: transformer.responseId, usage: transformer.usage }
}

export function createResponsesSseRepairStream(
  options: {
    modelOverride?: string
    repairIncompleteFinalItems?: boolean
    synthesizeFinalOnStreamEnd?: boolean
  } = {},
) {
  const repairer = new ResponsesStreamRepairer(options)
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = repairer.feed(chunk)
      if (text) controller.enqueue(textEncoder.encode(text))
    },
    flush(controller) {
      const text = repairer.finish()
      if (text) controller.enqueue(textEncoder.encode(text))
    },
  })
}

export function extractOutputText(responseBody: any) {
  const root = responsePayloadRoot(responseBody)
  let text = ""
  for (const item of root?.output || []) {
    if (item?.type !== "message") continue
    for (const part of item.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") text += part.text
    }
  }
  if (!text && typeof root?.output_text === "string") text = root.output_text
  return text
}

function extractResponseToolCalls(responseBody: any, reverseToolNameMap: Record<string, string> = {}) {
  const root = responsePayloadRoot(responseBody)
  const toolCalls = []
  for (const item of root?.output || []) {
    if (item?.type !== "function_call") continue
    const name = reverseToolNameMap[item.name] || item.name
    toolCalls.push({
      id: item.call_id || item.id,
      type: "function",
      function: {
        name,
        arguments:
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments || {}),
      },
    })
  }
  return toolCalls
}

function finishReasonFromResponse(responseBody: any, hasToolCalls: boolean) {
  const root = responsePayloadRoot(responseBody)
  if (hasToolCalls) return "tool_calls"
  if (root?.status === "incomplete") return "length"
  return "stop"
}

export function buildChatCompletionPayload(
  responseBody: any,
  requestedModel: string,
  reverseToolNameMap: Record<string, string> = {},
) {
  const root = responsePayloadRoot(responseBody)
  const toolCalls = extractResponseToolCalls(responseBody, reverseToolNameMap)
  const message: AnyRecord = {
    role: "assistant",
    content: extractOutputText(responseBody) || null,
  }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return {
    id: root?.id || `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: root?.created_at || root?.created || Math.floor(Date.now() / 1000),
    model: requestedModel || root?.model || "codex",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReasonFromResponse(responseBody, toolCalls.length > 0),
      },
    ],
    usage: root?.usage || undefined,
  }
}

export function extractFinalResponseFromSse(text: string) {
  let final: any = null
  let failed: any = null
  let responseId = ""
  let usage: any = null
  const outputItems = new Map<number, any>()
  const outputTextByItem = new Map<string, string>()
  for (const frame of parseSseFrames(text)) {
    const data = frame.data
    if (!data) continue
    const id = extractResponseId(data)
    if (id) responseId = id
    const itemUsage = extractUsage(data)
    if (itemUsage) usage = itemUsage
    const type = data.type || frame.event
    if ((type === "response.output_item.done" || type === "response.output_item.added") && data.item?.id) {
      outputItems.set(data.output_index ?? outputItems.size, data.item)
    }
    if (type === "response.output_text.done" && data.item_id && typeof data.text === "string") {
      outputTextByItem.set(data.item_id, data.text)
    }
    if (type === "response.content_part.done" && data.item_id && data.part?.type === "output_text") {
      outputTextByItem.set(data.item_id, data.part.text || "")
    }
    if (frame.event === "response.completed" || frame.event === "response.done" || data.type === "response.completed") {
      final = data.response || data
    } else if (!final && (frame.event === "response.failed" || data.type === "response.failed")) {
      failed = data.response || data
    } else if (isObject(data.response) && data.response.status === "completed") {
      final = data.response
    }
  }
  if (final && Array.isArray(final.output) && final.output.length === 0 && outputItems.size > 0) {
    final = {
      ...final,
      output: Array.from(outputItems.entries())
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([, item]) => item),
    }
  }
  if (final && (!Array.isArray(final.output) || final.output.length === 0) && outputTextByItem.size > 0) {
    final = {
      ...final,
      output: [
        {
          type: "message",
          role: "assistant",
          content: Array.from(outputTextByItem.values()).map((text) => ({
            type: "output_text",
            text,
          })),
        },
      ],
    }
  }
  return { final, failed, responseId, usage }
}

function chatChunkBase(id: string, model: string) {
  return {
    id: id || `chatcmpl_${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || "codex",
    choices: [{ index: 0, delta: {}, finish_reason: null as string | null }],
  }
}

function responseFailedMessage(data: AnyRecord) {
  const response = isObject(data.response) ? data.response : data
  const error = isObject(response.error) ? response.error : response
  return (
    (typeof error.message === "string" && error.message.trim()) ||
    (typeof error.detail === "string" && error.detail.trim()) ||
    "response.failed event received"
  )
}

function chatErrorSse(data: AnyRecord) {
  const response = isObject(data.response) ? data.response : data
  const error = isObject(response.error) ? response.error : {}
  return sse("error", {
    error: {
      message: responseFailedMessage(data),
      type: typeof error.type === "string" && error.type.trim() ? error.type.trim() : "server_error",
      code: error.code,
    },
  })
}

export function responsesSseToChatCompletionsSse(
  text: string,
  requestedModel: string,
  reverseToolNameMap: Record<string, string> = {},
) {
  const repaired = transformResponsesSseText(text)
  let responseId = repaired.responseId || ""
  let usage = repaired.usage
  let functionIndex = -1
  let finishReason = "stop"
  let out = ""
  let completed = false

  for (const frame of parseSseFrames(repaired.text)) {
    if (completed) continue
    const data = frame.data
    if (!data) continue
    const id = extractResponseId(data)
    if (id) responseId = id
    const itemUsage = extractUsage(data)
    if (itemUsage) usage = itemUsage
    const type = data.type || frame.event
    const chunk = chatChunkBase(responseId, requestedModel)
    if (type === "response.output_text.delta") {
      chunk.choices[0].delta = { content: data.delta || "" }
      out += sse("", chunk)
    } else if (type === "response.output_item.added" && data.item?.type === "function_call") {
      functionIndex += 1
      chunk.choices[0].delta = {
        tool_calls: [
          {
            index: functionIndex,
            id: data.item.call_id || data.item.id,
            type: "function",
            function: {
              name: reverseToolNameMap[data.item.name] || data.item.name,
              arguments: "",
            },
          },
        ],
      }
      out += sse("", chunk)
    } else if (type === "response.function_call_arguments.delta") {
      chunk.choices[0].delta = {
        tool_calls: [
          {
            index: Math.max(0, functionIndex),
            function: { arguments: data.delta || "" },
          },
        ],
      }
      out += sse("", chunk)
    } else if (type === "response.completed" || type === "response.done") {
      chunk.choices[0].delta = {}
      if (isObject(data.response) && data.response.status === "incomplete") {
        finishReason = "length"
      }
      chunk.choices[0].finish_reason = functionIndex >= 0 ? "tool_calls" : finishReason
      if (usage) {
        ;(chunk as AnyRecord).usage = usage
      }
      out += sse("", chunk)
      out += "data: [DONE]\n\n"
      completed = true
    } else if (type === "response.failed") {
      out += chatErrorSse(data)
      out += "data: [DONE]\n\n"
      break
    }
  }

  return out
}

export function createChatCompletionsSseStream(
  requestedModel: string,
  reverseToolNameMap: Record<string, string> = {},
) {
  const decoder = new TextDecoder()
  let buffer = ""
  let responseId = ""
  let usage: any = null
  let functionIndex = -1
  let finishReason = "stop"
  let completed = false

  function processFrame(frameText: string) {
    if (completed) return ""
    const frame = parseSseFrames(`${frameText}\n\n`)[0]
    const data = frame?.data
    if (!data) return ""
    const id = extractResponseId(data)
    if (id) responseId = id
    const itemUsage = extractUsage(data)
    if (itemUsage) usage = itemUsage
    const type = data.type || frame.event
    const chunk = chatChunkBase(responseId, requestedModel)

    if (type === "response.output_text.delta") {
      chunk.choices[0].delta = { content: data.delta || "" }
      return sse("", chunk)
    }
    if (type === "response.output_item.added" && data.item?.type === "function_call") {
      functionIndex += 1
      chunk.choices[0].delta = {
        tool_calls: [
          {
            index: functionIndex,
            id: data.item.call_id || data.item.id,
            type: "function",
            function: {
              name: reverseToolNameMap[data.item.name] || data.item.name,
              arguments: "",
            },
          },
        ],
      }
      return sse("", chunk)
    }
    if (type === "response.function_call_arguments.delta") {
      chunk.choices[0].delta = {
        tool_calls: [
          {
            index: Math.max(0, functionIndex),
            function: { arguments: data.delta || "" },
          },
        ],
      }
      return sse("", chunk)
    }
    if (type === "response.completed" || type === "response.done") {
      chunk.choices[0].delta = {}
      if (isObject(data.response) && data.response.status === "incomplete") {
        finishReason = "length"
      }
      chunk.choices[0].finish_reason = functionIndex >= 0 ? "tool_calls" : finishReason
      if (usage) {
        ;(chunk as AnyRecord).usage = usage
      }
      completed = true
      return `${sse("", chunk)}data: [DONE]\n\n`
    }
    if (type === "response.failed") {
      return `${chatErrorSse(data)}data: [DONE]\n\n`
    }
    return ""
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      while (true) {
        const boundary = splitSseFrame(buffer)
        if (!boundary) break
        const frameText = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.separatorLength)
        const out = processFrame(frameText)
        if (out) controller.enqueue(textEncoder.encode(out))
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer.trim()) {
        const out = processFrame(buffer)
        if (out) controller.enqueue(textEncoder.encode(out))
      }
    },
  })
}
