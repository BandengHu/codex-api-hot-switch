import "server-only"

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { resolveDataDir } from "./data-root"
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

function runtimePath(dataDir = resolveDataDir()) {
  return join(dataDir, "provider-endpoint-runtime.json")
}

/** 端点健康状态按数据目录分桶，不同账号的配额/封禁互不影响。 */
interface RuntimeBucket {
  cache: ProviderEndpointRuntimeState[] | null
  queue: Promise<unknown>
}

const buckets = new Map<string, RuntimeBucket>()

function bucketFor(dataDir = resolveDataDir()): RuntimeBucket {
  let bucket = buckets.get(dataDir)
  if (!bucket) {
    bucket = { cache: null, queue: Promise.resolve() }
    buckets.set(dataDir, bucket)
  }
  return bucket
}

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

async function loadStates(dataDir = resolveDataDir()) {
  const bucket = bucketFor(dataDir)
  if (bucket.cache) return bucket.cache
  const path = runtimePath(dataDir)
  try {
    const raw = await readFile(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<RuntimeFile>
    bucket.cache = Array.isArray(parsed.states)
      ? parsed.states.map(normalizeState).filter((state): state is ProviderEndpointRuntimeState => Boolean(state))
      : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    bucket.cache = []
  }
  return bucket.cache
}

async function persistStates(
  states: ProviderEndpointRuntimeState[],
  dataDir = resolveDataDir(),
) {
  const path = runtimePath(dataDir)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const value: RuntimeFile = { version: 1, states }
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(tempPath, path)
}

function enqueueMutation<T>(task: () => Promise<T>, dataDir = resolveDataDir()) {
  const bucket = bucketFor(dataDir)
  const run = bucket.queue.catch(() => undefined).then(task)
  bucket.queue = run.then(
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

function hasAvailableFailoverEndpoint(
  states: ProviderEndpointRuntimeState[],
  provider: Provider,
  currentEndpoint: ProviderEndpoint,
) {
  return provider.endpoints.some((endpoint) => {
    if (!endpoint.enabled || endpoint.id === currentEndpoint.id) return false
    const state = stateFor(states, provider, endpoint)
    clearExpiredCooldown(state)
    return (
      !state.quotaDisabled &&
      !state.authDisabled &&
      !isCooldownActive(state)
    )
  })
}

function clearAutomaticBlockWithoutFailoverEndpoint(
  states: ProviderEndpointRuntimeState[],
  provider: Provider,
  endpoint: ProviderEndpoint,
  state: ProviderEndpointRuntimeState,
) {
  if (
    !state.quotaDisabled &&
    !state.authDisabled &&
    !isCooldownActive(state)
  ) {
    return false
  }
  if (hasAvailableFailoverEndpoint(states, provider, endpoint)) return false
  state.quotaDisabled = false
  state.authDisabled = false
  delete state.cooldownUntil
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
  const dataDir = resolveDataDir()
  return enqueueMutation(async () => {
    const states = await loadStates(dataDir)
    const next = compactRuntimeStates(states, providers)
    let changed = next.length !== states.length
    const result = providers.flatMap((provider) => {
      const providerStates = provider.endpoints.map((endpoint) => {
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
        return { endpoint, state }
      })
      for (const { endpoint, state } of providerStates) {
        if (clearAutomaticBlockWithoutFailoverEndpoint(next, provider, endpoint, state)) {
          changed = true
        }
      }
      return providerStates.map(({ state }) => ({ ...state }))
    })
    if (changed) {
      bucketFor(dataDir).cache = next
      await persistStates(next, dataDir)
    }
    return result
  }, dataDir)
}

async function getProviderRuntimeStates(provider: Provider) {
  const dataDir = resolveDataDir()
  return enqueueMutation(async () => {
    const states = await loadStates(dataDir)
    let changed = false
    const providerStates = provider.endpoints.map((endpoint) => {
      const existing = states.find(
        (state) =>
          state.providerId === provider.id &&
          state.endpointId === endpoint.id &&
          state.credentialFingerprint === credentialFingerprint(provider, endpoint),
      )
      if (existing) {
        if (clearExpiredCooldown(existing)) changed = true
        return { endpoint, state: existing }
      }
      changed = true
      const state = stateFor(states, provider, endpoint)
      if (clearExpiredCooldown(state)) changed = true
      return { endpoint, state }
    })
    for (const { endpoint, state } of providerStates) {
      if (clearAutomaticBlockWithoutFailoverEndpoint(states, provider, endpoint, state)) {
        changed = true
      }
    }
    if (changed) {
      await persistStates(states, dataDir)
    }
    return providerStates.map(({ state }) => ({ ...state }))
  }, dataDir)
}

export async function resetProviderEndpointRuntime(
  providerId: string,
  endpointId: string,
) {
  const dataDir = resolveDataDir()
  return enqueueMutation(async () => {
    const states = await loadStates(dataDir)
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
    await persistStates(states, dataDir)
  }, dataDir)
}

export async function recordProviderEndpointSuccess(
  provider: Provider,
  endpoint: ProviderEndpoint,
) {
  const dataDir = resolveDataDir()
  return enqueueMutation(async () => {
    const states = await loadStates(dataDir)
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
    await persistStates(states, dataDir)
  }, dataDir)
}

export async function recordProviderEndpointFailure(
  provider: Provider,
  endpoint: ProviderEndpoint,
  classification: EndpointFailureClassification,
) {
  const dataDir = resolveDataDir()
  return enqueueMutation(async () => {
    const states = await loadStates(dataDir)
    const state = stateFor(states, provider, endpoint)
    state.updatedAt = new Date().toISOString()
    state.lastError = classification.message

    if (classification.kind === "quota") {
      const shouldFailover = hasAvailableFailoverEndpoint(states, provider, endpoint)
      state.quotaDisabled = shouldFailover
      state.consecutiveFailures = 0
      delete state.cooldownUntil
      await persistStates(states, dataDir)
      return { shouldFailover, state: { ...state } }
    }

    if (classification.kind === "auth") {
      const shouldFailover = hasAvailableFailoverEndpoint(states, provider, endpoint)
      state.authDisabled = shouldFailover
      state.consecutiveFailures = 0
      delete state.cooldownUntil
      await persistStates(states, dataDir)
      return { shouldFailover, state: { ...state } }
    }

    if (classification.kind !== "transient") {
      await persistStates(states, dataDir)
      return { shouldFailover: false, state: { ...state } }
    }

    state.consecutiveFailures += 1
    const shouldFailover =
      state.consecutiveFailures >= ENDPOINT_FAILURE_THRESHOLD &&
      hasAvailableFailoverEndpoint(states, provider, endpoint)
    if (shouldFailover) {
      state.cooldownUntil = new Date(Date.now() + ENDPOINT_COOLDOWN_MS).toISOString()
    } else {
      delete state.cooldownUntil
    }
    await persistStates(states, dataDir)
    return { shouldFailover, state: { ...state } }
  }, dataDir)
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

function looksLikeModelChannelUnavailable(text: string) {
  return /(no available channel for model|model[_ -]?not[_ -]?found)/i.test(text)
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

  if (looksLikeModelChannelUnavailable(text)) {
    return { kind: "terminal", message, status }
  }
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
