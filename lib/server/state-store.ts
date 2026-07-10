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
import { appendTelemetryLog, importLegacyTelemetry } from "@/lib/server/telemetry-store"
import { REASONING_DIALECTS } from "@/lib/types"
import type {
  ConsoleSnapshot,
  FloatingBallPosition,
  Model,
  ModelMapping,
  Provider,
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
const STATE_VERSION = 1

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
  const hint = `${provider.name} ${provider.baseUrl}`.toLowerCase()
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

function normalizeProvider(provider: Provider): Provider {
  const storedProtocol = String(provider.protocol)
  const protocol =
    storedProtocol === "openai" || storedProtocol === "custom"
      ? provider.id === "prov-openai"
        ? "openai-responses"
        : "openai-chat"
      : provider.protocol
  const normalizedProvider = { ...provider, protocol }
  const fallbackDialect = inferProviderReasoningDialect(normalizedProvider)
  return {
    ...normalizedProvider,
    protocol,
    bodyOverride: typeof provider.bodyOverride === "string" ? provider.bodyOverride : "",
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
  const hint = `${provider.name} ${provider.baseUrl} ${provider.protocol}`.toLowerCase()
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
  const providers = Array.isArray(value.providers)
    ? value.providers.map(normalizeProvider)
    : seed.providers
  const models = Array.isArray(value.models)
    ? sortBuiltInModels(value.models.map(normalizeModel))
    : sortBuiltInModels(seed.models)
  const settings = normalizeSettings(value.settings ?? {}, seed.settings)
  const validCodexSubagentModelSlugs = new Set([
    CODEX_AUTO_MODEL_SLUG,
    ...models
      .filter((model) => model.enabled && isChatModel(model))
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
    runtime: normalizedRuntime,
    settings,
  })
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true })
}

async function writeState(snapshot: ConsoleSnapshot) {
  await ensureDataDir()
  const tempPath = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`
  const { logs: _logs, tokenStats: _tokenStats, ...configSnapshot } = snapshot
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
    if (Array.isArray(parsed.logs) || Array.isArray(parsed.tokenStats)) {
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
  return cloneSnapshot(await loadSnapshot())
}

export async function getRoutingSnapshot(): Promise<RoutingSnapshot> {
  return cloneRoutingSnapshot(await loadSnapshot())
}

export async function saveSnapshot(snapshot: ConsoleSnapshot): Promise<ConsoleSnapshot> {
  return enqueueStateMutation(async () => {
    const normalized = normalizeSnapshot(snapshot)
    await persistSnapshot(normalized)
    return cloneSnapshot(normalized)
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

export async function ensureParentDir(path: string) {
  await mkdir(dirname(path), { recursive: true })
}
