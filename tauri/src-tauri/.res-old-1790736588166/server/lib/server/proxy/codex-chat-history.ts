import "server-only"

import {
  CodexChatTranscriptStore,
  transcriptIndexKey,
  transcriptPrefixIndexKeys,
  type TranscriptNode,
} from "./codex-chat-transcript"

type AnyRecord = Record<string, any>

export const MAX_CACHED_RESPONSES = 512
export const MAX_CACHED_TRANSCRIPT_BYTES = 64 * 1024 * 1024

const CALL_ITEM_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "web_search_call",
])
const CALL_OUTPUT_ITEM_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
])

interface CachedResponse {
  callsById: Map<string, AnyRecord>
  callOrder: string[]
  transcriptTail?: TranscriptNode
  transcriptComplete: boolean
}

interface CachedLookup {
  previous?: CachedResponse
  fallback: CachedResponse
}

interface TranscriptCandidate {
  tail: TranscriptNode
  complete: boolean
}

export interface CodexChatHistoryStats {
  responseCount: number
  completeResponseCount: number
  transcriptNodeCount: number
  transcriptItemCount: number
  transcriptBytes: number
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function cloneJson<T>(value: T): T {
  return structuredClone(value) as T
}

function emptyCachedResponse(): CachedResponse {
  return {
    callsById: new Map(),
    callOrder: [],
    transcriptComplete: false,
  }
}

function textInputItem(text: string) {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }
}

function inputItemsFromRequestInput(input: unknown) {
  if (typeof input === "string") return [textInputItem(input)]
  if (Array.isArray(input)) return input
  if (isObject(input)) return [input]
  return []
}

function responseOutputItems(response: AnyRecord) {
  return Array.isArray(response.output) ? cloneJson(response.output) : []
}

function responseItemCallId(item: AnyRecord) {
  return safeTrim(item.call_id || item.id || item.tool_call_id || item.item_id)
}

function isReplacementTranscriptItem(item: unknown) {
  if (!isObject(item)) return false
  const type = safeTrim(item.type)
  if (CALL_ITEM_TYPES.has(type) || CALL_OUTPUT_ITEM_TYPES.has(type)) return true
  return type === "message" && safeTrim(item.role) === "assistant"
}

function shouldTreatInputAsReplacementTranscript(items: unknown[]) {
  return items.some(isReplacementTranscriptItem)
}

function isEmptyValue(value: unknown) {
  if (value == null) return true
  if (typeof value === "string") return !value.trim()
  if (Array.isArray(value)) return value.length === 0
  if (isObject(value)) return Object.keys(value).length === 0
  return false
}

function cachedCallItem(item: unknown): [string, AnyRecord] | null {
  if (!isObject(item) || !CALL_ITEM_TYPES.has(safeTrim(item.type))) return null
  const callId = responseItemCallId(item)
  return callId ? [callId, item] : null
}

function enrichCallItemFromCache(item: AnyRecord, cached: AnyRecord) {
  let changed = false
  for (const key of [
    "name",
    "namespace",
    "arguments",
    "input",
    "status",
    "execution",
    "action",
    "reasoning_content",
    "reasoning",
    "gemini_thought_signature",
  ]) {
    if (!isEmptyValue(item[key])) continue
    if (isEmptyValue(cached[key])) continue
    item[key] = cloneJson(cached[key])
    changed = true
  }
  return changed
}

function appendRestoreGroup(
  response: CachedResponse,
  outputCallIds: Set<string>,
  existingCallIds: Set<string>,
  groupedCallIds: Set<string>,
  group: Array<[string, AnyRecord]>,
) {
  for (const callId of response.callOrder) {
    if (
      !outputCallIds.has(callId) ||
      existingCallIds.has(callId) ||
      groupedCallIds.has(callId)
    ) {
      continue
    }
    const item = response.callsById.get(callId)
    if (!item) continue
    groupedCallIds.add(callId)
    group.push([callId, cloneJson(item)])
  }
}

export class CodexChatHistoryStore {
  private responses = new Map<string, CachedResponse>()
  private responseOrder: string[] = []
  private callIndex = new Map<string, string[]>()
  private transcriptIndex = new Map<string, string[]>()
  private transcripts = new CodexChatTranscriptStore()

  constructor(
    private readonly limits: {
      maxResponses?: number
      maxTranscriptBytes?: number
    } = {},
  ) {}

  recordResponse(response: unknown, requestBody?: unknown) {
    if (!isObject(response)) return 0
    const responseId = safeTrim(response.id)
    if (!responseId) return 0

    const outputItems = responseOutputItems(response)
    const calls = outputItems.flatMap((item: unknown) => {
      const cached = cachedCallItem(item)
      return cached ? [cached] : []
    })
    const existing = this.responses.get(responseId)
    const transcript =
      !existing?.transcriptTail && isObject(requestBody)
        ? this.buildTranscript(requestBody, outputItems)
        : undefined

    if (calls.length === 0 && !transcript) return 0
    return this.insertResponse(responseId, calls, transcript)
  }

  enrichRequest(body: AnyRecord) {
    const previousResponseId = safeTrim(body.previous_response_id)
    const input = body.input
    const originalWasObject = isObject(input)
    const items = Array.isArray(input) ? input : originalWasObject ? [input] : null
    if (!items) return 0

    const outputCallIds = new Set<string>()
    const existingCallIds = new Set<string>()
    for (const item of items) {
      if (!isObject(item)) continue
      const callId = responseItemCallId(item)
      if (!callId) continue
      const type = safeTrim(item.type)
      if (CALL_OUTPUT_ITEM_TYPES.has(type)) outputCallIds.add(callId)
      if (CALL_ITEM_TYPES.has(type)) existingCallIds.add(callId)
    }

    const requestedCallIds = new Set([...outputCallIds, ...existingCallIds])
    if (requestedCallIds.size === 0) return 0

    const lookup = this.lookup(previousResponseId, requestedCallIds)
    const restoreGroup = this.restoreGroup(lookup, outputCallIds, existingCallIds)
    const restoreGroupIds = new Set(restoreGroup.map(([callId]) => callId))
    let pendingRestoreGroup: Array<[string, AnyRecord]> | null = restoreGroup
    const seenCallIds = new Set<string>()
    const newItems: unknown[] = []
    let restored = 0
    let enriched = 0

    for (const rawItem of items) {
      const item = isObject(rawItem) ? { ...rawItem } : rawItem
      if (!isObject(item)) {
        newItems.push(item)
        continue
      }

      const type = safeTrim(item.type)
      if (CALL_ITEM_TYPES.has(type)) {
        const callId = responseItemCallId(item)
        if (callId) {
          const cached = this.lookupCall(lookup, callId)
          if (cached && enrichCallItemFromCache(item, cached)) enriched += 1
          seenCallIds.add(callId)
        }
        newItems.push(item)
        continue
      }

      if (CALL_OUTPUT_ITEM_TYPES.has(type)) {
        if (pendingRestoreGroup && pendingRestoreGroup.length > 0) {
          for (const [callId, cachedItem] of pendingRestoreGroup) {
            seenCallIds.add(callId)
            newItems.push(cloneJson(cachedItem))
            restored += 1
          }
          pendingRestoreGroup = null
        }

        const callId = responseItemCallId(item)
        if (callId && !seenCallIds.has(callId) && !restoreGroupIds.has(callId)) {
          const cached = this.lookupCall(lookup, callId)
          if (cached) {
            seenCallIds.add(callId)
            newItems.push(cloneJson(cached))
            restored += 1
          }
        }
        newItems.push(item)
        continue
      }

      newItems.push(item)
    }

    const changed = restored + enriched
    if (changed === 0) return 0
    body.input = originalWasObject && newItems.length === 1 ? newItems[0] : newItems
    return changed
  }

  expandRequestHistory(body: AnyRecord) {
    const previousResponseId = safeTrim(body.previous_response_id)
    const input = body.input
    const originalWasObject = isObject(input)
    const currentItems = inputItemsFromRequestInput(input)
    if (!previousResponseId || currentItems.length === 0) {
      return this.enrichRequest(body)
    }

    if (shouldTreatInputAsReplacementTranscript(currentItems)) {
      delete body.previous_response_id
      return this.enrichRequest(body)
    }

    const previous = this.responses.get(previousResponseId)
    if (!previous?.transcriptTail || !previous.transcriptComplete) {
      return this.enrichRequest(body)
    }

    this.touchResponse(previousResponseId)
    const previousItems = this.transcripts.materialize(previous.transcriptTail)
    body.input =
      originalWasObject && previousItems.length === 0 && currentItems.length === 1
        ? currentItems[0]
        : [...previousItems, ...currentItems]
    delete body.previous_response_id
    return previousItems.length
  }

  stats(): CodexChatHistoryStats {
    let completeResponseCount = 0
    let transcriptItemCount = 0
    const nodes = new Set<TranscriptNode>()

    for (const response of this.responses.values()) {
      if (response.transcriptComplete) completeResponseCount += 1
      let node = response.transcriptTail
      while (node && !nodes.has(node)) {
        nodes.add(node)
        transcriptItemCount += node.items.length
        node = node.previous
      }
    }

    return {
      responseCount: this.responses.size,
      completeResponseCount,
      transcriptNodeCount: this.transcripts.nodeCount,
      transcriptItemCount,
      transcriptBytes: this.transcripts.bytes,
    }
  }

  private buildTranscript(requestBody: AnyRecord, outputItems: unknown[]): TranscriptCandidate | undefined {
    const inputItems = inputItemsFromRequestInput(requestBody.input)
    const previousResponseId = safeTrim(requestBody.previous_response_id)
    const replacementTranscript = shouldTreatInputAsReplacementTranscript(inputItems)
    let previousTail: TranscriptNode | undefined
    let prefixItems = 0
    let complete = !previousResponseId || replacementTranscript

    if (previousResponseId && !replacementTranscript) {
      const previous = this.responses.get(previousResponseId)
      if (previous?.transcriptTail) {
        previousTail = previous.transcriptTail
        complete = previous.transcriptComplete
        this.touchResponse(previousResponseId)
      }
    }

    if (!previousTail) {
      const prefix = this.longestCompletePrefix(inputItems)
      if (prefix?.transcriptTail) {
        previousTail = prefix.transcriptTail
        prefixItems = prefix.transcriptTail.itemCount
        complete = true
      }
    }

    const newInputItems = inputItems.slice(prefixItems)
    const storedItems = [
      ...cloneJson(newInputItems),
      ...outputItems,
    ]
    if (storedItems.length === 0) {
      return previousTail ? { tail: previousTail, complete } : undefined
    }

    return {
      tail: this.transcripts.createNode(previousTail, storedItems),
      complete,
    }
  }

  private longestCompletePrefix(items: unknown[]) {
    const indexKeys = transcriptPrefixIndexKeys(items)
    for (let index = indexKeys.length - 1; index >= 0; index -= 1) {
      const key = indexKeys[index]
      const responseIds = this.transcriptIndex.get(key)
      if (!responseIds) continue
      for (let offset = responseIds.length - 1; offset >= 0; offset -= 1) {
        const responseId = responseIds[offset]
        const response = this.responses.get(responseId)
        if (!response?.transcriptTail || !response.transcriptComplete) continue
        this.touchResponse(responseId)
        return response
      }
    }
    return undefined
  }

  private insertResponse(
    responseId: string,
    calls: Array<[string, AnyRecord]>,
    transcript?: TranscriptCandidate,
  ) {
    let response = this.responses.get(responseId)
    if (!response) {
      response = emptyCachedResponse()
      this.responses.set(responseId, response)
      this.responseOrder.push(responseId)
    } else {
      this.touchResponse(responseId)
    }

    let changed = 0
    if (transcript && !response.transcriptTail) {
      response.transcriptTail = transcript.tail
      response.transcriptComplete = transcript.complete
      transcript.tail.responseRefs += 1
      if (transcript.complete) this.indexTranscript(responseId, transcript.tail)
      changed += transcript.tail.items.length
    }

    for (const [callId, item] of calls) {
      if (!response.callsById.has(callId)) response.callOrder.push(callId)
      response.callsById.set(callId, item)
      this.indexCall(callId, responseId)
      changed += 1
    }

    this.prune()
    return changed
  }

  private lookup(previousResponseId: string, requestedCallIds: Set<string>): CachedLookup {
    const previous = previousResponseId
      ? this.responses.get(previousResponseId)
      : undefined
    if (previous) this.touchResponse(previousResponseId)
    return {
      previous,
      fallback: this.uniqueFallbackCalls(requestedCallIds, previous),
    }
  }

  private lookupCall(lookup: CachedLookup, callId: string) {
    return (
      lookup.previous?.callsById.get(callId) ??
      lookup.fallback.callsById.get(callId)
    )
  }

  private restoreGroup(
    lookup: CachedLookup,
    outputCallIds: Set<string>,
    existingCallIds: Set<string>,
  ) {
    const group: Array<[string, AnyRecord]> = []
    const groupedCallIds = new Set<string>()
    if (lookup.previous) {
      appendRestoreGroup(
        lookup.previous,
        outputCallIds,
        existingCallIds,
        groupedCallIds,
        group,
      )
    }
    appendRestoreGroup(
      lookup.fallback,
      outputCallIds,
      existingCallIds,
      groupedCallIds,
      group,
    )
    return group
  }

  private uniqueFallbackCalls(
    requestedCallIds: Set<string>,
    previous?: CachedResponse,
  ) {
    const selected = new Map<string, AnyRecord>()
    for (const callId of requestedCallIds) {
      if (previous?.callsById.has(callId)) continue
      const item = this.uniqueCall(callId)
      if (item) selected.set(callId, cloneJson(item))
    }

    const fallback = emptyCachedResponse()
    for (const responseId of this.responseOrder) {
      const response = this.responses.get(responseId)
      if (!response) continue
      for (const callId of response.callOrder) {
        const item = selected.get(callId)
        if (!item) continue
        fallback.callOrder.push(callId)
        fallback.callsById.set(callId, item)
        selected.delete(callId)
      }
    }
    return fallback
  }

  private uniqueCall(callId: string) {
    const responseIds = this.callIndex.get(callId)
    if (!responseIds) return null
    let found: AnyRecord | null = null
    for (const responseId of responseIds) {
      const item = this.responses.get(responseId)?.callsById.get(callId)
      if (!item) continue
      if (found) return null
      found = item
    }
    return found
  }

  private indexCall(callId: string, responseId: string) {
    const responseIds = this.callIndex.get(callId) ?? []
    if (!responseIds.includes(responseId)) responseIds.push(responseId)
    this.callIndex.set(callId, responseIds)
  }

  private indexTranscript(responseId: string, tail: TranscriptNode) {
    const key = transcriptIndexKey(tail.itemCount, tail.sequenceHash)
    const responseIds = this.transcriptIndex.get(key) ?? []
    if (!responseIds.includes(responseId)) responseIds.push(responseId)
    this.transcriptIndex.set(key, responseIds)
  }

  private unindexTranscript(responseId: string, response: CachedResponse) {
    if (!response.transcriptTail || !response.transcriptComplete) return
    const key = transcriptIndexKey(
      response.transcriptTail.itemCount,
      response.transcriptTail.sequenceHash,
    )
    const responseIds = this.transcriptIndex.get(key) ?? []
    const next = responseIds.filter((id) => id !== responseId)
    if (next.length > 0) this.transcriptIndex.set(key, next)
    else this.transcriptIndex.delete(key)
  }

  private touchResponse(responseId: string) {
    const index = this.responseOrder.indexOf(responseId)
    if (index < 0 || index === this.responseOrder.length - 1) return
    this.responseOrder.splice(index, 1)
    this.responseOrder.push(responseId)
  }

  private removeResponse(responseId: string) {
    const response = this.responses.get(responseId)
    if (!response) return
    this.responses.delete(responseId)
    const orderIndex = this.responseOrder.indexOf(responseId)
    if (orderIndex >= 0) this.responseOrder.splice(orderIndex, 1)
    this.unindexTranscript(responseId, response)

    if (response.transcriptTail) {
      response.transcriptTail.responseRefs = Math.max(
        0,
        response.transcriptTail.responseRefs - 1,
      )
      this.transcripts.release(response.transcriptTail)
    }

    for (const callId of response.callOrder) {
      const responseIds = this.callIndex.get(callId) ?? []
      const next = responseIds.filter((id) => id !== responseId)
      if (next.length > 0) this.callIndex.set(callId, next)
      else this.callIndex.delete(callId)
    }
  }

  private prune() {
    const maxResponses = Math.max(1, this.limits.maxResponses ?? MAX_CACHED_RESPONSES)
    const maxTranscriptBytes = Math.max(
      1,
      this.limits.maxTranscriptBytes ?? MAX_CACHED_TRANSCRIPT_BYTES,
    )
    while (
      this.responseOrder.length > maxResponses ||
      (this.transcripts.bytes > maxTranscriptBytes && this.responseOrder.length > 1)
    ) {
      const responseId = this.responseOrder[0]
      if (!responseId) break
      this.removeResponse(responseId)
    }
  }
}

const codexChatHistory = new CodexChatHistoryStore()

export function enrichCodexChatRequest(body: AnyRecord) {
  return codexChatHistory.enrichRequest(body)
}

export function expandCodexResponsesRequest(body: AnyRecord) {
  return codexChatHistory.expandRequestHistory(body)
}

export function recordCodexChatResponse(response: unknown, requestBody?: unknown) {
  return codexChatHistory.recordResponse(response, requestBody)
}
