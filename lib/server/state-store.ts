import "server-only"

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  CODEX_AUTO_MODEL_SLUG,
  CODEX_SUBAGENT_ROLE_COUNT,
  codexRoutedModelSlug,
  defaultCodexSubagentModelSlugs,
} from "@/lib/codex-model-slug"
import { initialSnapshot } from "@/lib/mock-data"
import { isChatModel, isImageGenerationModel } from "@/lib/model-capabilities"
import { createProviderEndpoint } from "@/lib/provider-endpoints"
import {
  clampWorkbuddyContextLength,
  isWorkbuddyProvider,
  seedWorkbuddyBuiltin,
} from "@/lib/workbuddy-provider"
import {
  getProviderEndpointRuntimeStates,
  resetProviderEndpointRuntime,
} from "@/lib/server/provider-endpoint-runtime"
import { appendTelemetryLog, importLegacyTelemetry } from "@/lib/server/telemetry-store"
import { REASONING_DIALECTS } from "@/lib/types"
import type {
  ConsoleSnapshot,
  FloatingBallPosition,
  Model,
  ModelMapping,
  Provider,
  ProviderEndpoint,
  ProtocolType,
  ReasoningDialect,
  ReasoningEffort,
  RequestLog,
  RoutingSnapshot,
  RuntimeConfig,
  Settings,
  WebSearchMode,
} from "@/lib/types"

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

const DATA_DIR = process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir()
const STATE_PATH = join(DATA_DIR, "hot-switch-state.json")
// 3 起内置供应商与内置模型只在升级那一次铺一遍，之后用户增删都算数。
const STATE_VERSION = 3

let writeQueue: Promise<unknown> = Promise.resolve()
let snapshotCache: ConsoleSnapshot | null = null

function cloneSnapshot(snapshot: ConsoleSnapshot): ConsoleSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as ConsoleSnapshot
}

function cloneRoutingSnapshot(snapshot: ConsoleSnapshot): RoutingSnapshot {
  return {
    providers: structuredClone(snapshot.providers),
    models: structuredClone(snapshot.models),
    mappings: structuredClone(snapshot.mappings),
    runtime: structuredClone(snapshot.runtime),
    settings: structuredClone(snapshot.settings),
  }
}

const REASONING_DIALECT_SET = new Set<ReasoningDialect>(REASONING_DIALECTS)

function isReasoningDialect(value: unknown): value is ReasoningDialect {
  return typeof value === "string" && REASONING_DIALECT_SET.has(value as ReasoningDialect)
}

function inferProviderReasoningDialect(provider: Provider): ReasoningDialect {
  const protocol = String(provider.protocol)
  const hint = `${provider.name} ${provider.endpoints[0]?.baseUrl || ""}`.toLowerCase()
  if (protocol === "openai-responses") return "openai-reasoning-effort"
  if (protocol === "anthropic" || protocol === "gemini") return "none"
  if (hint.includes("api.deepseek.com")) return "deepseek-official"
  if (hint.includes("openrouter")) return "openrouter-reasoning"
  if (
    hint.includes("dashscope") ||
    hint.includes("aliyuncs") ||
    hint.includes("bailian")
  ) {
    return "qwen-enable-thinking"
  }
  if (hint.includes("siliconflow")) return "siliconflow-enable-thinking"
  if (hint.includes("moonshot") || hint.includes("kimi")) return "kimi-thinking"
  if (hint.includes("bigmodel") || hint.includes("zhipu")) return "glm-thinking"
  if (hint.includes("minimax")) return "minimax-reasoning-split"
  if (hint.includes("stepfun")) return "stepfun-low-high"
  if (hint.includes("volces") || hint.includes("volcengine") || hint.includes("ark")) {
    return "volcengine-thinking"
  }
  if (hint.includes("qianfan") || hint.includes("baidubce")) return "none"
  if (hint.includes("tokenhub.tencentmaas.com")) return "tencent-tokenhub-thinking"
  return "auto"
}

function normalizeProvider(rawProvider: Provider | Record<string, unknown>): Provider {
  const provider = rawProvider as Record<string, unknown>
  const id = typeof provider.id === "string" ? provider.id : `prov-${crypto.randomUUID()}`
  const storedProtocol = String(provider.protocol)
  const protocol: ProtocolType =
    storedProtocol === "openai" || storedProtocol === "custom"
      ? id === "prov-openai"
        ? "openai-responses"
        : "openai-chat"
      : storedProtocol === "openai-responses" ||
          storedProtocol === "openai-chat" ||
          storedProtocol === "anthropic" ||
          storedProtocol === "gemini"
        ? storedProtocol
        : "openai-responses"
  const rawEndpoints = Array.isArray(provider.endpoints)
    ? provider.endpoints
    : [
        {
          id: `${id}-primary`,
          name: "主用",
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          enabled: true,
        },
      ]
  const endpoints: ProviderEndpoint[] = rawEndpoints.map((value, index) => {
    const endpoint = value && typeof value === "object"
      ? value as Partial<ProviderEndpoint>
      : {}
    return createProviderEndpoint(id, {
      id: typeof endpoint.id === "string" && endpoint.id.trim()
        ? endpoint.id.trim()
        : `${id}-${index === 0 ? "primary" : `fallback-${index}`}`,
      name:
        typeof endpoint.name === "string" && endpoint.name.trim()
          ? endpoint.name.trim()
          : index === 0
            ? "主用"
            : `备用 ${index}`,
      baseUrl: typeof endpoint.baseUrl === "string" ? endpoint.baseUrl.trim() : "",
      apiKey: typeof endpoint.apiKey === "string" ? endpoint.apiKey : "",
      enabled: endpoint.enabled !== false,
    })
  })
  if (endpoints.length === 0) {
    endpoints.push(createProviderEndpoint(id, {
      id: `${id}-primary`,
      name: "主用",
      baseUrl: typeof provider.baseUrl === "string" ? provider.baseUrl : "",
      apiKey: typeof provider.apiKey === "string" ? provider.apiKey : "",
      enabled: true,
    }))
  }
  const {
    baseUrl: _legacyBaseUrl,
    apiKey: _legacyApiKey,
    endpoints: _rawEndpoints,
    ...providerWithoutLegacyCredentials
  } = provider
  const normalizedProvider = {
    ...providerWithoutLegacyCredentials,
    id,
    protocol,
    endpoints,
  } as Provider
  const fallbackDialect = inferProviderReasoningDialect(normalizedProvider)
  return {
    ...normalizedProvider,
    protocol,
    bodyOverride:
      typeof provider.bodyOverride === "string" ? provider.bodyOverride : "",
    rawResponsesPassthrough:
      protocol === "openai-responses" &&
      typeof provider.rawResponsesPassthrough === "boolean"
        ? provider.rawResponsesPassthrough
        : false,
    reasoningDialect:
      isReasoningDialect(provider.reasoningDialect) &&
      !(provider.reasoningDialect === "auto" && fallbackDialect !== "auto")
        ? provider.reasoningDialect
        : fallbackDialect,
  }
}

function normalizeModel(model: Model): Model {
  const stored = model.reasoningDialect
  return {
    ...model,
    reasoningDialect:
      stored === "inherit" || isReasoningDialect(stored) ? stored : "inherit",
  }
}

/**
 * 把 WorkBuddy 系模型的上下文长度收敛到账号实际可用容量。
 *
 * 老状态里存的还是上游目录报的 100 万；只在铺底那一刻改常量管不到已存数据，所以这里
 * 按供应商归属在读取时统一压一次，用户自己填的更小值不动。
 */
function clampWorkbuddyModelContexts(models: Model[], providers: Provider[]): Model[] {
  const workbuddyProviderIds = new Set(
    providers.filter((provider) => isWorkbuddyProvider(provider)).map((provider) => provider.id),
  )
  if (workbuddyProviderIds.size === 0) return models
  return models.map((model) =>
    workbuddyProviderIds.has(model.providerId)
      ? { ...model, contextLength: clampWorkbuddyContextLength(model.contextLength) }
      : model,
  )
}

function normalizeFloatingBallPosition(value: unknown): FloatingBallPosition | undefined {
  if (!value || typeof value !== "object") return undefined
  const position = value as Partial<FloatingBallPosition>
  return Number.isFinite(position.x) && Number.isFinite(position.y)
    ? { x: Number(position.x), y: Number(position.y) }
    : undefined
}

function normalizeWebSearchMode(value: unknown, fallback: WebSearchMode): WebSearchMode {
  return value === "builtin" || value === "mcp" || value === "disabled"
    ? value
    : fallback
}

function normalizeCodexSubagentModelSlugs(value: unknown, fallback: string[]) {
  const source = Array.isArray(value) ? value : fallback
  return Array.from({ length: CODEX_SUBAGENT_ROLE_COUNT }, (_, index) => {
    const slug = source[index]
    return typeof slug === "string" && slug.trim()
      ? slug.trim()
      : CODEX_AUTO_MODEL_SLUG
  })
}

function normalizeSettings(
  rawSettings: Partial<Settings> & { imageGenerationModel?: unknown },
  seed: Settings,
): Settings {
  const { imageGenerationModel: _removedImageGenerationModel, ...settings } =
    rawSettings
  const defaultReasoning = settings.defaultReasoning ?? seed.defaultReasoning
  return {
    ...seed,
    ...settings,
    defaultReasoning,
    auxiliaryRoutingEnabled:
      typeof settings.auxiliaryRoutingEnabled === "boolean"
        ? settings.auxiliaryRoutingEnabled
        : seed.auxiliaryRoutingEnabled,
    auxiliaryProviderId:
      typeof settings.auxiliaryProviderId === "string" &&
      settings.auxiliaryProviderId.trim()
        ? settings.auxiliaryProviderId
        : seed.auxiliaryProviderId,
    auxiliaryModelId:
      typeof settings.auxiliaryModelId === "string" && settings.auxiliaryModelId.trim()
        ? settings.auxiliaryModelId
        : seed.auxiliaryModelId,
    auxiliaryReasoning: settings.auxiliaryReasoning ?? seed.auxiliaryReasoning,
    codexSubagentModelSlugs: normalizeCodexSubagentModelSlugs(
      settings.codexSubagentModelSlugs,
      seed.codexSubagentModelSlugs ?? defaultCodexSubagentModelSlugs(),
    ),
    imageGenerationProviderId:
      typeof settings.imageGenerationProviderId === "string" &&
      settings.imageGenerationProviderId.trim()
        ? settings.imageGenerationProviderId
        : seed.imageGenerationProviderId,
    imageGenerationModelId:
      typeof settings.imageGenerationModelId === "string" &&
      settings.imageGenerationModelId.trim()
        ? settings.imageGenerationModelId
        : seed.imageGenerationModelId,
    floatingBallEnabled:
      typeof settings.floatingBallEnabled === "boolean"
        ? settings.floatingBallEnabled
        : seed.floatingBallEnabled,
    floatingBallPosition: normalizeFloatingBallPosition(settings.floatingBallPosition),
    tokenStatsResetAt:
      typeof settings.tokenStatsResetAt === "string" && settings.tokenStatsResetAt.trim()
        ? settings.tokenStatsResetAt
        : seed.tokenStatsResetAt,
    fullRequestLoggingEnabled:
      typeof settings.fullRequestLoggingEnabled === "boolean"
        ? settings.fullRequestLoggingEnabled
        : seed.fullRequestLoggingEnabled,
    webSearchMode: normalizeWebSearchMode(settings.webSearchMode, seed.webSearchMode),
  }
}

function isClaudeProvider(provider: Provider) {
  const hint = `${provider.name} ${provider.endpoints[0]?.baseUrl || ""} ${provider.protocol}`.toLowerCase()
  return hint.includes("anthropic") || hint.includes("claude")
}

function removeInvalidProviderModels(snapshot: ConsoleSnapshot): ConsoleSnapshot {
  const claudeProviderIds = new Set(
    snapshot.providers.filter(isClaudeProvider).map((provider) => provider.id),
  )
  if (claudeProviderIds.size === 0) return snapshot

  const removedModelIds = new Set<string>()
  const models = snapshot.models.filter((model) => {
    const shouldRemove =
      claudeProviderIds.has(model.providerId) && model.modelId.toLowerCase().startsWith("gpt-")
    if (shouldRemove) removedModelIds.add(model.id)
    return !shouldRemove
  })
  if (removedModelIds.size === 0) return snapshot

  const fallbackChatModel = models.find(
    (model) => claudeProviderIds.has(model.providerId) && isChatModel(model),
  ) || models.find(isChatModel)
  const fallbackImageModel = models.find(isImageGenerationModel)
  const replaceModelId = (modelId: string) =>
    removedModelIds.has(modelId) ? fallbackChatModel?.id || modelId : modelId

  return {
    ...snapshot,
    models,
    mappings: snapshot.mappings
      .map((mapping) => ({
        ...mapping,
        targetModelId: replaceModelId(mapping.targetModelId),
      }))
      .filter((mapping) => !removedModelIds.has(mapping.targetModelId)),
    runtime: removedModelIds.has(snapshot.runtime.activeModelId) && fallbackChatModel
      ? {
          ...snapshot.runtime,
          activeProviderId: fallbackChatModel.providerId,
          activeModelId: fallbackChatModel.id,
        }
      : snapshot.runtime,
    settings: {
      ...snapshot.settings,
      defaultProviderId:
        removedModelIds.has(snapshot.settings.defaultModelId) && fallbackChatModel
          ? fallbackChatModel.providerId
          : snapshot.settings.defaultProviderId,
      defaultModelId:
        removedModelIds.has(snapshot.settings.defaultModelId) && fallbackChatModel
          ? fallbackChatModel.id
          : snapshot.settings.defaultModelId,
      imageGenerationProviderId:
        removedModelIds.has(snapshot.settings.imageGenerationModelId) && fallbackImageModel
          ? fallbackImageModel.providerId
          : snapshot.settings.imageGenerationProviderId,
      imageGenerationModelId:
        removedModelIds.has(snapshot.settings.imageGenerationModelId) && fallbackImageModel
          ? fallbackImageModel.id
          : snapshot.settings.imageGenerationModelId,
    },
  }
}
function sortBuiltInModels(models: Model[]) {
  const seedOrder = new Map(
    initialSnapshot.models.map((model, index) => [
      `${model.providerId}:${model.modelId.toLowerCase()}`,
      index,
    ]),
  )
  const providerOrder = new Map<string, number>()
  for (const model of models) {
    if (!providerOrder.has(model.providerId)) {
      providerOrder.set(model.providerId, providerOrder.size)
    }
  }
  return [...models].sort((a, b) => {
    const providerDelta =
      (providerOrder.get(a.providerId) ?? 0) -
      (providerOrder.get(b.providerId) ?? 0)
    if (providerDelta !== 0) return providerDelta
    const aOrder = seedOrder.get(`${a.providerId}:${a.modelId.toLowerCase()}`)
    const bOrder = seedOrder.get(`${b.providerId}:${b.modelId.toLowerCase()}`)
    if (aOrder == null && bOrder == null) return 0
    if (aOrder == null) return 1
    if (bOrder == null) return -1
    return aOrder - bOrder
  })
}

function normalizeSnapshot(value: Partial<ConsoleSnapshot>): ConsoleSnapshot {
  const seed = cloneSnapshot(initialSnapshot)
  // 内置供应商（WorkBuddy 本机账号）只在老数据里没有它时补一次，之后用户增删都算数。
  const seeded = seedWorkbuddyBuiltin(
    Array.isArray(value.providers)
      ? value.providers.map(normalizeProvider)
      : seed.providers,
    sortBuiltInModels(
      Array.isArray(value.models) ? value.models.map(normalizeModel) : seed.models,
    ),
    Number(value.version) || 0,
  )
  const providers = seeded.providers
  const models = clampWorkbuddyModelContexts(seeded.models, providers)
  const settings = normalizeSettings(value.settings ?? {}, seed.settings)
  const enabledProviderIds = new Set(
    providers.filter((provider) => provider.enabled).map((provider) => provider.id),
  )
  const validCodexSubagentModelSlugs = new Set([
    CODEX_AUTO_MODEL_SLUG,
    ...models
      .filter(
        (model) =>
          model.enabled &&
          enabledProviderIds.has(model.providerId) &&
          isChatModel(model),
      )
      .map(codexRoutedModelSlug),
  ])
  settings.codexSubagentModelSlugs = settings.codexSubagentModelSlugs.map((slug) =>
    validCodexSubagentModelSlugs.has(slug) ? slug : CODEX_AUTO_MODEL_SLUG,
  )
  const validDefaultModel =
    models.some((model) => model.id === settings.defaultModelId && isChatModel(model))
  if (!validDefaultModel) {
    const fallback = models.find(
      (model) => model.providerId === settings.defaultProviderId && isChatModel(model),
    ) || models.find(isChatModel)
    settings.defaultProviderId = fallback?.providerId ?? settings.defaultProviderId
    settings.defaultModelId = fallback?.id ?? settings.defaultModelId
  }
  const validAuxiliaryModel =
    models.some(
      (model) =>
        model.id === settings.auxiliaryModelId &&
        model.providerId === settings.auxiliaryProviderId &&
        isChatModel(model),
    )
  if (!validAuxiliaryModel) {
    const fallback = models.find(
      (model) =>
        model.providerId === settings.auxiliaryProviderId &&
        isChatModel(model),
    ) || models.find(isChatModel)
    settings.auxiliaryProviderId = fallback?.providerId ?? settings.auxiliaryProviderId
    settings.auxiliaryModelId = fallback?.id ?? settings.auxiliaryModelId
  }
  const validImageModel = models.some(
    (model) =>
      model.id === settings.imageGenerationModelId &&
      model.providerId === settings.imageGenerationProviderId &&
      isImageGenerationModel(model),
  )
  if (!validImageModel) {
    const fallback = models.find(
      (model) =>
        model.providerId === settings.imageGenerationProviderId &&
        isImageGenerationModel(model),
    ) || models.find(isImageGenerationModel)
    settings.imageGenerationProviderId =
      fallback?.providerId ?? settings.imageGenerationProviderId
    settings.imageGenerationModelId =
      fallback?.id ?? settings.imageGenerationModelId
  }
  const runtime = value.runtime ?? seed.runtime
  const runtimeModel = models.find((model) => model.id === runtime.activeModelId)
  const normalizedRuntime =
    runtimeModel && isChatModel(runtimeModel)
      ? {
          ...runtime,
          reasoning: runtime.reasoning,
        }
      : {
          ...runtime,
          activeProviderId: settings.defaultProviderId,
          activeModelId: settings.defaultModelId,
        }
  return removeInvalidProviderModels({
    version: STATE_VERSION,
    providers,
    models,
    mappings: Array.isArray(value.mappings) ? value.mappings : seed.mappings,
    logs: [],
    tokenStats: [],
    endpointStates: [],
    runtime: normalizedRuntime,
    settings,
  })
}

function containsLegacyProviderCredentials(value: Partial<ConsoleSnapshot>) {
  return Array.isArray(value.providers) && value.providers.some((provider) => {
    if (!provider || typeof provider !== "object") return false
    const record = provider as unknown as Record<string, unknown>
    return "baseUrl" in record || "apiKey" in record
  })
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true })
}

async function writeState(snapshot: ConsoleSnapshot) {
  await ensureDataDir()
  const tempPath = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`
  const {
    logs: _logs,
    tokenStats: _tokenStats,
    endpointStates: _endpointStates,
    ...configSnapshot
  } = snapshot
  await writeFile(tempPath, `${JSON.stringify(configSnapshot, null, 2)}\n`, "utf8")
  await rename(tempPath, STATE_PATH)
}

async function loadSnapshot(): Promise<ConsoleSnapshot> {
  if (snapshotCache) return snapshotCache
  try {
    const raw = await readFile(STATE_PATH, "utf8")
    const parsed = JSON.parse(raw) as Partial<ConsoleSnapshot>
    const normalized = normalizeSnapshot(parsed)
    snapshotCache = normalized
    if (
      parsed.version !== STATE_VERSION ||
      Array.isArray(parsed.logs) ||
      Array.isArray(parsed.tokenStats) ||
      containsLegacyProviderCredentials(parsed)
    ) {
      await importLegacyTelemetry(
        {
          logs: parsed.logs,
          tokenStats: parsed.tokenStats,
        },
        normalized.settings,
      )
      await writeState(normalized)
    }
    return snapshotCache
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw error
    const seeded = normalizeSnapshot(cloneSnapshot(initialSnapshot))
    snapshotCache = seeded
    await writeState(seeded)
    return seeded
  }
}

async function persistSnapshot(snapshot: ConsoleSnapshot) {
  snapshotCache = snapshot
  await writeState(snapshot)
  return snapshot
}

function enqueueStateMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.catch(() => undefined).then(task)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function flushPendingLogs(): Promise<void> {
  await Promise.resolve()
}

export async function getSnapshot(): Promise<ConsoleSnapshot> {
  await writeQueue.catch(() => undefined)
  const snapshot = cloneSnapshot(await loadSnapshot())
  return {
    ...snapshot,
    endpointStates: await getProviderEndpointRuntimeStates(snapshot.providers),
  }
}

export async function getRoutingSnapshot(): Promise<RoutingSnapshot> {
  return cloneRoutingSnapshot(await loadSnapshot())
}

export async function saveSnapshot(snapshot: ConsoleSnapshot): Promise<ConsoleSnapshot> {
  return enqueueStateMutation(async () => {
    const current = await loadSnapshot()
    const normalized = normalizeSnapshot(snapshot)
    await persistSnapshot(normalized)
    const currentProviders = new Map(
      current.providers.map((provider) => [provider.id, provider]),
    )
    for (const provider of normalized.providers) {
      const previousProvider = currentProviders.get(provider.id)
      const previousEndpoints = new Map(
        previousProvider?.endpoints.map((endpoint) => [endpoint.id, endpoint]) || [],
      )
      for (const endpoint of provider.endpoints) {
        const previousEndpoint = previousEndpoints.get(endpoint.id)
        const manuallyReenabled =
          endpoint.enabled &&
          (
            previousEndpoint?.enabled === false ||
            previousProvider?.enabled === false
          )
        if (manuallyReenabled) {
          await resetProviderEndpointRuntime(provider.id, endpoint.id)
        }
      }
    }
    return {
      ...cloneSnapshot(normalized),
      endpointStates: await getProviderEndpointRuntimeStates(normalized.providers),
    }
  })
}

export async function updateSnapshot(
  updater: (snapshot: ConsoleSnapshot) => ConsoleSnapshot,
): Promise<ConsoleSnapshot> {
  return enqueueStateMutation(async () => {
    const current = cloneSnapshot(await loadSnapshot())
    const normalized = normalizeSnapshot(updater(current))
    await persistSnapshot(normalized)
    return cloneSnapshot(normalized)
  })
}

export async function replaceProviders(providers: Provider[]) {
  return updateSnapshot((snapshot) => ({ ...snapshot, providers }))
}

export async function replaceModels(models: Model[]) {
  return updateSnapshot((snapshot) => ({ ...snapshot, models }))
}

export async function replaceMappings(mappings: ModelMapping[]) {
  return updateSnapshot((snapshot) => ({ ...snapshot, mappings }))
}

export async function replaceRuntime(runtime: RuntimeConfig) {
  return updateSnapshot((snapshot) => ({ ...snapshot, runtime }))
}

export async function replaceSettings(settings: Settings) {
  return updateSnapshot((snapshot) => ({ ...snapshot, settings }))
}

export async function appendLog(log: RequestLog): Promise<ConsoleSnapshot> {
  const snapshot = await loadSnapshot()
  await appendTelemetryLog(log, snapshot.settings)
  return snapshot
}

export async function exportSnapshotText(): Promise<string> {
  await flushPendingLogs()
  const snapshot = await getSnapshot()
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

export async function importSnapshotText(text: string): Promise<ConsoleSnapshot> {
  const parsed = JSON.parse(text) as Partial<ConsoleSnapshot>
  return saveSnapshot(parsed as ConsoleSnapshot)
}

export function stateFilePath() {
  return STATE_PATH
}

export function hotSwitchDataDir() {
  return DATA_DIR
}

export async function ensureParentDir(path: string) {
  await mkdir(dirname(path), { recursive: true })
}
