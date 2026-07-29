import "server-only"

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  effectiveEndpointBaseUrl,
  resolveProviderEndpoint,
} from "@/lib/provider-endpoints"
import type {
  Provider,
  ProviderEndpoint,
  ProviderEndpointRuntimeState,
  ResolvedProvider,
} from "@/lib/types"

export const ENDPOINT_FAILURE_THRESHOLD = 4
export const ENDPOINT_COOLDOWN_MS = 30 * 60 * 1000

export type EndpointFailureKind = "quota" | "auth" | "transient" | "terminal"

export interface EndpointFailureClassification {
  kind: EndpointFailureKind
  message: string
  status?: number
}

export class EndpointAttemptError extends Error {
  readonly kind: EndpointFailureKind
  readonly status?: number
  readonly payload?: unknown

  constructor(params: {
    kind: EndpointFailureKind
    message: string
    status?: number
    payload?: unknown
  }) {
    super(params.message)
    this.name = "EndpointAttemptError"
    this.kind = params.kind
    this.status = params.status
    this.payload = params.payload
  }
}

type RuntimeFile = {
  version: 1
  states: ProviderEndpointRuntimeState[]
}

function defaultDataDir() {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "codex-api-hot-switch",
      "data",
    )
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "codex-api-hot-switch", "data")
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "codex-api-hot-switch",
    "data",
  )
}

const RUNTIME_PATH = join(
  process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir(),
  "provider-endpoint-runtime.json",
)

let stateCache: ProviderEndpointRuntimeState[] | null = null
let writeQueue: Promise<unknown> = Promise.resolve()

function endpointKey(providerId: string, endpointId: string) {
  return `${providerId}:${endpointId}`
}

function credentialFingerprint(provider: Provider, endpoint: ProviderEndpoint) {
  return createHash("sha256")
    .update(`${effectiveEndpointBaseUrl(provider, endpoint)}\n${endpoint.apiKey}`)
    .digest("hex")
}

function emptyState(
  provider: Provider,
  endpoint: ProviderEndpoint,
): ProviderEndpointRuntimeState {
  return {
    providerId: provider.id,
    endpointId: endpoint.id,
    credentialFingerprint: credentialFingerprint(provider, endpoint),
    consecutiveFailures: 0,
    quotaDisabled: false,
    authDisabled: false,
    updatedAt: new Date().toISOString(),
  }
}

function normalizeState(value: unknown): ProviderEndpointRuntimeState | null {
  if (!value || typeof value !== "object") return null
  const state = value as Partial<ProviderEndpointRuntimeState>
  if (
    typeof state.providerId !== "string" ||
    typeof state.endpointId !== "string" ||
    typeof state.credentialFingerprint !== "string"
  ) {
    return null
  }
  return {
    providerId: state.providerId,
    endpointId: state.endpointId,
    credentialFingerprint: state.credentialFingerprint,
    consecutiveFailures: Math.max(0, Number(state.consecutiveFailures) || 0),
    ...(typeof state.cooldownUntil === "string"
      ? { cooldownUntil: state.cooldownUntil }
      : {}),
    quotaDisabled: state.quotaDisabled === true,
    authDisabled: state.authDisabled === true,
    ...(typeof state.lastError === "string" ? { lastError: state.lastError } : {}),
    updatedAt:
      typeof state.updatedAt === "string"
        ? state.updatedAt
        : new Date().toISOString(),
  }
}

async function loadStates() {
  if (stateCache) return stateCache
  try {
    const raw = await readFile(RUNTIME_PATH, "utf8")
    const parsed = JSON.parse(raw) as Partial<RuntimeFile>
    stateCache = Array.isArray(parsed.states)
      ? parsed.states.map(normalizeState).filter((state): state is ProviderEndpointRuntimeState => Boolean(state))
      : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    stateCache = []
  }
  return stateCache
}

async function persistStates(states: ProviderEndpointRuntimeState[]) {
  await mkdir(dirname(RUNTIME_PATH), { recursive: true })
  const tempPath = `${RUNTIME_PATH}.${process.pid}.${Date.now()}.tmp`
  const value: RuntimeFile = { version: 1, states }
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(tempPath, RUNTIME_PATH)
}

function enqueueMutation<T>(task: () => Promise<T>) {
  const run = writeQueue.catch(() => undefined).then(task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function isCooldownActive(state: ProviderEndpointRuntimeState) {
  return Boolean(
    state.cooldownUntil &&
      Number.isFinite(Date.parse(state.cooldownUntil)) &&
      Date.parse(state.cooldownUntil) > Date.now(),
  )
}

function clearExpiredCooldown(state: ProviderEndpointRuntimeState) {
  if (!state.cooldownUntil) return false
  const cooldownAt = Date.parse(state.cooldownUntil)
  if (Number.isFinite(cooldownAt) && cooldownAt > Date.now()) return false
  state.consecutiveFailures = 0
  delete state.cooldownUntil
  delete state.lastError
  state.updatedAt = new Date().toISOString()
  return true
}

function stateFor(
  states: ProviderEndpointRuntimeState[],
  provider: Provider,
  endpoint: ProviderEndpoint,
) {
  const key = endpointKey(provider.id, endpoint.id)
  const fingerprint = credentialFingerprint(provider, endpoint)
  const existing = states.find(
    (state) =>
      endpointKey(state.providerId, state.endpointId) === key &&
      state.credentialFingerprint === fingerprint,
  )
  if (existing) return existing
  const replacement = emptyState(provider, endpoint)
  const index = states.findIndex(
    (state) => endpointKey(state.providerId, state.endpointId) === key,
  )
  if (index >= 0) states[index] = replacement
  else states.push(replacement)
  return replacement
}

function compactRuntimeStates(
  states: ProviderEndpointRuntimeState[],
  providers: Provider[],
) {
  const validKeys = new Set(
    providers.flatMap((provider) =>
      provider.endpoints.map((endpoint) => endpointKey(provider.id, endpoint.id)),
    ),
  )
  return states.filter((state) =>
    validKeys.has(endpointKey(state.providerId, state.endpointId)),
  )
}

export async function getProviderEndpointRuntimeStates(providers: Provider[]) {
  return enqueueMutation(async () => {
    const states = await loadStates()
    const next = compactRuntimeStates(states, providers)
    let changed = next.length !== states.length
    const result = providers.flatMap((provider) =>
      provider.endpoints.map((endpoint) => {
        const existing = next.find(
          (state) =>
            state.providerId === provider.id &&
            state.endpointId === endpoint.id,
        )
        if (
          !existing ||
          existing.credentialFingerprint !== credentialFingerprint(provider, endpoint)
        ) {
          changed = true
        }
        const before = next.length
        const state = stateFor(next, provider, endpoint)
        if (next.length !== before) changed = true
        if (clearExpiredCooldown(state)) changed = true
        return { ...state }
      }),
    )
    if (changed) {
      stateCache = next
      await persistStates(next)
    }
    return result
  })
}

async function getProviderRuntimeStates(provider: Provider) {
  return enqueueMutation(async () => {
    const states = await loadStates()
    let changed = false
    const result = provider.endpoints.map((endpoint) => {
      const existing = states.find(
        (state) =>
          state.providerId === provider.id &&
          state.endpointId === endpoint.id &&
          state.credentialFingerprint === credentialFingerprint(provider, endpoint),
      )
      if (existing) {
        if (clearExpiredCooldown(existing)) changed = true
        return { ...existing }
      }
      changed = true
      const state = stateFor(states, provider, endpoint)
      if (clearExpiredCooldown(state)) changed = true
      return { ...state }
    })
    if (changed) {
      await persistStates(states)
    }
    return result
  })
}

export async function resetProviderEndpointRuntime(
  providerId: string,
  endpointId: string,
) {
  return enqueueMutation(async () => {
    const states = await loadStates()
    const state = states.find(
      (value) => value.providerId === providerId && value.endpointId === endpointId,
    )
    if (!state) return
    state.consecutiveFailures = 0
    delete state.cooldownUntil
    state.quotaDisabled = false
    state.authDisabled = false
    delete state.lastError
    state.updatedAt = new Date().toISOString()
    await persistStates(states)
  })
}

export async function recordProviderEndpointSuccess(
  provider: Provider,
  endpoint: ProviderEndpoint,
) {
  return enqueueMutation(async () => {
    const states = await loadStates()
    const state = stateFor(states, provider, endpoint)
    if (
      state.consecutiveFailures === 0 &&
      !state.cooldownUntil &&
      !state.quotaDisabled &&
      !state.authDisabled &&
      !state.lastError
    ) {
      return
    }
    state.consecutiveFailures = 0
    delete state.cooldownUntil
    delete state.lastError
    state.updatedAt = new Date().toISOString()
    await persistStates(states)
  })
}

export async function recordProviderEndpointFailure(
  provider: Provider,
  endpoint: ProviderEndpoint,
  classification: EndpointFailureClassification,
) {
  return enqueueMutation(async () => {
    const states = await loadStates()
    const state = stateFor(states, provider, endpoint)
    state.updatedAt = new Date().toISOString()
    state.lastError = classification.message

    if (classification.kind === "quota") {
      state.quotaDisabled = true
      state.consecutiveFailures = 0
      delete state.cooldownUntil
      await persistStates(states)
      return { shouldFailover: true, state: { ...state } }
    }

    if (classification.kind === "auth") {
      state.authDisabled = true
      state.consecutiveFailures = 0
      delete state.cooldownUntil
      await persistStates(states)
      return { shouldFailover: true, state: { ...state } }
    }

    if (classification.kind !== "transient") {
      await persistStates(states)
      return { shouldFailover: false, state: { ...state } }
    }

    state.consecutiveFailures += 1
    const shouldFailover = state.consecutiveFailures >= ENDPOINT_FAILURE_THRESHOLD
    if (shouldFailover) {
      state.cooldownUntil = new Date(Date.now() + ENDPOINT_COOLDOWN_MS).toISOString()
    }
    await persistStates(states)
    return { shouldFailover, state: { ...state } }
  })
}

export async function availableProviderEndpoints(provider: Provider) {
  const states = await getProviderRuntimeStates(provider)
  const stateById = new Map(states.map((state) => [state.endpointId, state]))
  return provider.endpoints.filter((endpoint) => {
    if (!endpoint.enabled) return false
    const state = stateById.get(endpoint.id)
    return !state?.quotaDisabled && !state?.authDisabled && !isCooldownActive(state || emptyState(provider, endpoint))
  })
}

export function endpointTargetProvider(
  provider: Provider,
  endpoint: ProviderEndpoint,
): ResolvedProvider {
  return resolveProviderEndpoint(provider, endpoint)
}

function normalizedErrorText(payload: unknown, text = "") {
  const values: string[] = [text]
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      values.push(value)
      return
    }
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(payload)
  return values.join(" ").toLowerCase()
}

function looksLikeQuota(text: string) {
  return /(insufficient[_ -]?quota|quota[_ -]?(exceeded|exhausted|limit)|daily[_ -]?limit|billing|balance|额度|余额|欠费|用量上限|超出配额|配额不足)/i.test(
    text,
  )
}

function errorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const error = (payload as Record<string, unknown>).error
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message
      if (typeof message === "string" && message.trim()) return message.trim()
    }
  }
  return fallback
}

export function classifyEndpointFailure(params: {
  status?: number
  payload?: unknown
  text?: string
  error?: unknown
}): EndpointFailureClassification {
  const status = params.status
  const text = normalizedErrorText(
    params.payload,
    `${params.text || ""} ${params.error instanceof Error ? params.error.message : params.error || ""}`,
  )
  const message = errorMessage(
    params.payload,
    params.error instanceof Error
      ? params.error.message
      : typeof params.error === "string" && params.error.trim()
        ? params.error.trim()
        : params.text || "上游端点失败",
  )

  if (looksLikeQuota(text) || status === 402) {
    return { kind: "quota", message, status }
  }
  if (status === 401) return { kind: "auth", message, status }
  if (status === 403) return { kind: "terminal", message, status }
  if (status != null && (status === 408 || status === 425 || status === 429 || status >= 500)) {
    return { kind: "transient", message, status }
  }
  if (
    params.error ||
    /(timeout|timed out|fetch failed|econn|enotfound|connection|bad gateway|gateway timeout|首包|空流|未响应)/i.test(
      text,
    )
  ) {
    return { kind: "transient", message, status }
  }
  return { kind: "terminal", message, status }
}

function parseSseFrame(raw: string) {
  let event = ""
  const dataLines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
  }
  const dataText = dataLines.join("\n")
  if (!dataText || dataText === "[DONE]") {
    return { event, dataText, payload: undefined as unknown }
  }
  try {
    return { event, dataText, payload: JSON.parse(dataText) as unknown }
  } catch {
    return { event, dataText, payload: undefined as unknown }
  }
}

function frameIsSemantic(frame: ReturnType<typeof parseSseFrame>) {
  const payload =
    frame.payload && typeof frame.payload === "object"
      ? frame.payload as Record<string, unknown>
      : {}
  const type = String(frame.event || payload.type || "").toLowerCase()
  if (type === "response.failed") {
    const classification = classifyEndpointFailure({
      status: 200,
      payload: frame.payload,
      text: frame.dataText,
    })
    throw new EndpointAttemptError({
      ...classification,
      payload: frame.payload,
    })
  }
  if (
    type === "response.completed" ||
    type === "response.done" ||
    type === "message_stop"
  ) {
    return true
  }
  if (type === "response.output_item.added") {
    const item =
      payload.item && typeof payload.item === "object"
        ? payload.item as Record<string, unknown>
        : {}
    const itemType = String(item.type || "").toLowerCase()
    if (
      itemType.includes("function_call") ||
      itemType.includes("tool") ||
      itemType.includes("image_generation")
    ) {
      return true
    }
  }
  if (type === "content_block_start") {
    const block =
      payload.content_block && typeof payload.content_block === "object"
        ? payload.content_block as Record<string, unknown>
        : {}
    const blockType = String(block.type || "").toLowerCase()
    return (
      blockType === "tool_use" ||
      (typeof block.text === "string" && block.text.length > 0) ||
      (typeof block.thinking === "string" && block.thinking.length > 0)
    )
  }
  if (type.includes("delta")) {
    if (typeof payload.delta === "string" && payload.delta.length > 0) {
      return true
    }
    const delta =
      payload.delta && typeof payload.delta === "object"
        ? payload.delta as Record<string, unknown>
        : {}
    if (
      (typeof delta.text === "string" && delta.text.length > 0) ||
      (typeof delta.thinking === "string" && delta.thinking.length > 0) ||
      (typeof delta.partial_json === "string" && delta.partial_json.length > 0) ||
      Array.isArray(delta.tool_calls) ||
      Boolean(delta.function_call)
    ) {
      return true
    }
  }
  if (Array.isArray(payload.choices)) {
    return payload.choices.some((choice) => {
      if (!choice || typeof choice !== "object") return false
      const delta = (choice as Record<string, unknown>).delta
      if (!delta || typeof delta !== "object") return false
      const value = delta as Record<string, unknown>
      return Boolean(value.content || value.reasoning_content || value.tool_calls || value.function_call)
    })
  }
  if (Array.isArray(payload.candidates)) {
    return payload.candidates.some((candidate) => {
      if (!candidate || typeof candidate !== "object") return false
      const content = (candidate as Record<string, unknown>).content
      if (!content || typeof content !== "object") return false
      const parts = (content as Record<string, unknown>).parts
      if (!Array.isArray(parts)) return false
      return parts.some((part) => {
        if (!part || typeof part !== "object") return false
        const value = part as Record<string, unknown>
        return (
          (typeof value.text === "string" && value.text.length > 0) ||
          Boolean(value.functionCall) ||
          Boolean(value.function_call)
        )
      })
    })
  }
  if (type === "ping" || type.endsWith(".created") || type.endsWith(".in_progress")) {
    return false
  }
  return false
}

export async function prepareUpstreamResponse(
  response: Response,
  requestIsStream: boolean,
  options: {
    requestSignal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<Response> {
  if (!response.ok || !response.body) return response

  if (!requestIsStream) {
    try {
      const body = new Uint8Array(await response.arrayBuffer())
      const headers = new Headers(response.headers)
      const text = new TextDecoder().decode(body)
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        payload = undefined
      }
      if (payload && typeof payload === "object" && "error" in payload) {
        const classification = classifyEndpointFailure({
          status: response.status,
          payload,
          text,
        })
        if (classification.kind !== "terminal") {
          throw new EndpointAttemptError({ ...classification, payload })
        }
      }
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch (error) {
      if (error instanceof EndpointAttemptError) throw error
      throw new EndpointAttemptError({
        ...classifyEndpointFailure({ error }),
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() || ""
  if (!contentType.includes("text/event-stream")) return response

  const reader = response.body.getReader()
  const buffered: Uint8Array[] = []
  const decoder = new TextDecoder()
  let textBuffer = ""
  let semantic = false
  let controlError: Error | undefined
  const timeoutMs = Math.max(0, options.timeoutMs || 0)
  const cancelReader = (reason: string) => {
    void reader.cancel(reason).catch(() => undefined)
  }
  const onClientAbort = () => {
    controlError = new Error("客户端已取消请求，上游请求已中止")
    cancelReader("client request cancelled")
  }
  if (options.requestSignal?.aborted) {
    onClientAbort()
  } else {
    options.requestSignal?.addEventListener("abort", onClientAbort, { once: true })
  }
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        controlError = new EndpointAttemptError({
          kind: "transient",
          message: `上游流在首个有效输出前超时：超过 ${timeoutMs}ms 未收到有效事件`,
        })
        cancelReader("upstream first semantic event timeout")
      }, timeoutMs)
    : undefined
  try {
    while (!semantic) {
      const next = await reader.read()
      if (controlError) throw controlError
      if (next.done) {
        throw new EndpointAttemptError({
          ...classifyEndpointFailure({ error: "上游流在首个有效输出前结束：空流" }),
        })
      }
      if (!next.value?.length) continue
      buffered.push(next.value)
      textBuffer += decoder.decode(next.value, { stream: true })
      const frames = textBuffer.split(/\r?\n\r?\n/)
      textBuffer = frames.pop() || ""
      for (const rawFrame of frames) {
        if (frameIsSemantic(parseSseFrame(rawFrame))) {
          semantic = true
          break
        }
      }
    }
  } catch (error) {
    if (controlError) throw controlError
    if (!controlError) {
      try {
        await reader.cancel(error)
      } catch {
        // The upstream may already have closed the stream.
      }
    }
    if (error instanceof EndpointAttemptError) throw error
    throw new EndpointAttemptError({
      ...classifyEndpointFailure({ error }),
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (timeout) clearTimeout(timeout)
    options.requestSignal?.removeEventListener("abort", onClientAbort)
  }

  let sentBuffered = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentBuffered) {
        sentBuffered = true
        buffered.forEach((chunk) => controller.enqueue(chunk))
        return
      }
      const next = await reader.read()
      if (next.done) {
        controller.close()
        return
      }
      if (next.value) controller.enqueue(next.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  })
}
