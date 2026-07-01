import "server-only"

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { initialSnapshot } from "@/lib/mock-data"
import { isChatModel, isImageGenerationModel } from "@/lib/model-capabilities"
import { tokenStatFromLog } from "@/lib/token-stats"
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
  TokenStatEntry,
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
const MAX_LOGS = 500
const MAX_TOKEN_STATS = 2000
const DAY_MS = 24 * 60 * 60 * 1000

let writeQueue: Promise<unknown> = Promise.resolve()
let snapshotCache: ConsoleSnapshot | null = null
// 节流写盘：日志写入只更新内存缓存并标脏，由定时器合并落盘，避免每条请求都做整快照深拷贝/序列化阻塞主链路。
let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null
let pendingFlushPromise: Promise<void> | null = null
let resolvePendingFlush: (() => void) | null = null
const LOG_FLUSH_DELAY_MS = 1000

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

function normalizeReasoningEffort(value: ReasoningEffort): ReasoningEffort {
  if (value === "minimal") return "low"
  if (value === "max") return "xhigh"
  return value
}
function normalizeFloatingBallPosition(value: unknown): FloatingBallPosition | undefined {
  if (!value || typeof value !== "object") return undefined
  const position = value as Partial<FloatingBallPosition>
  return Number.isFinite(position.x) && Number.isFinite(position.y)
    ? { x: Number(position.x), y: Number(position.y) }
    : undefined
}

function normalizeSettings(
  rawSettings: Partial<Settings> & { imageGenerationModel?: unknown },
  seed: Settings,
): Settings {
  const { imageGenerationModel: _removedImageGenerationModel, ...settings } =
    rawSettings
  const defaultReasoning = normalizeReasoningEffort(settings.defaultReasoning ?? seed.defaultReasoning)
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
    auxiliaryReasoning: normalizeReasoningEffort(
      settings.auxiliaryReasoning ?? seed.auxiliaryReasoning,
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
          reasoning: normalizeReasoningEffort(runtime.reasoning),
        }
      : {
          ...runtime,
          activeProviderId: settings.defaultProviderId,
          activeModelId: settings.defaultModelId,
        }
  const logs = pruneLogs(Array.isArray(value.logs) ? value.logs : seed.logs, settings)
  const tokenStats = normalizeTokenStats(value.tokenStats, logs)
  return removeInvalidProviderModels({
    version: STATE_VERSION,
    providers,
    models,
    mappings: Array.isArray(value.mappings) ? value.mappings : seed.mappings,
    logs,
    tokenStats,
    runtime: normalizedRuntime,
    settings,
  })
}

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true })
}

function pruneLogs(logs: RequestLog[], settings: Settings) {
  const retentionDays = Math.max(1, Number(settings.logRetentionDays) || 1)
  const cutoff = Date.now() - retentionDays * DAY_MS
  return logs
    .filter((log) => {
      const timestamp = Date.parse(log.timestamp)
      return !Number.isFinite(timestamp) || timestamp >= cutoff
    })
    .slice(0, MAX_LOGS)
}

function normalizeTokenStats(value: unknown, logs: RequestLog[]): TokenStatEntry[] {
  if (Array.isArray(value) && value.length > 0) {
    return value
      .filter((entry): entry is TokenStatEntry => {
        if (!entry || typeof entry !== "object") return false
        const stat = entry as Partial<TokenStatEntry>
        return (
          typeof stat.id === "string" &&
          typeof stat.timestamp === "string" &&
          typeof stat.providerId === "string" &&
          typeof stat.modelId === "string" &&
          typeof stat.codexModel === "string" &&
          Number.isFinite(stat.statusCode) &&
          Number.isFinite(stat.inputTokens) &&
          Number.isFinite(stat.outputTokens) &&
          Number.isFinite(stat.totalTokens)
        )
      })
      .map((entry) => ({
        ...entry,
        cachedInputTokens: Number(entry.cachedInputTokens) || 0,
        cacheCreationInputTokens: Number(entry.cacheCreationInputTokens) || 0,
        reasoningTokens: Number(entry.reasoningTokens) || 0,
      }))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, MAX_TOKEN_STATS)
  }

  return logs
    .map(tokenStatFromLog)
    .filter((entry): entry is TokenStatEntry => Boolean(entry))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, MAX_TOKEN_STATS)
}

async function writeState(snapshot: ConsoleSnapshot) {
  await ensureDataDir()
  const tempPath = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
  await rename(tempPath, STATE_PATH)
}

async function loadSnapshot(): Promise<ConsoleSnapshot> {
  if (snapshotCache) return snapshotCache
  try {
    const raw = await readFile(STATE_PATH, "utf8")
    snapshotCache = normalizeSnapshot(JSON.parse(raw) as Partial<ConsoleSnapshot>)
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

// 把当前内存缓存（已含最新日志）通过同一写队列落盘，与 updateSnapshot 串行，避免相互覆盖。
function flushLogsNow(): Promise<void> {
  if (pendingFlushTimer) {
    clearTimeout(pendingFlushTimer)
    pendingFlushTimer = null
  }
  const resolve = resolvePendingFlush
  resolvePendingFlush = null
  pendingFlushPromise = null
  return enqueueStateMutation(async () => {
    if (snapshotCache) await writeState(snapshotCache)
  }).then(
    () => resolve?.(),
    () => resolve?.(),
  )
}

function scheduleLogFlush() {
  if (!pendingFlushPromise) {
    pendingFlushPromise = new Promise<void>((resolve) => {
      resolvePendingFlush = resolve
    })
  }
  if (pendingFlushTimer) return
  pendingFlushTimer = setTimeout(() => {
    pendingFlushTimer = null
    void flushLogsNow()
  }, LOG_FLUSH_DELAY_MS)
  // 不要让节流定时器拖住进程退出。
  pendingFlushTimer.unref?.()
}

// 供读取路径在返回前确保已落盘的最新日志可见（getSnapshot 已 await writeQueue，
// 这里额外把内存中尚未触发写盘的脏日志立即冲刷，保证导出/读取的一致性）。
export async function flushPendingLogs(): Promise<void> {
  if (pendingFlushPromise) {
    await flushLogsNow()
  }
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
    // appendLog 在主链路里原地追加日志到内存缓存，updateSnapshot 的深拷贝可能错过
    // await 期间新写入的日志/统计；回写前用缓存中最新的两者覆盖，避免丢日志。
    if (snapshotCache) {
      normalized.logs = snapshotCache.logs.slice(0, MAX_LOGS)
      normalized.tokenStats = snapshotCache.tokenStats.slice(0, MAX_TOKEN_STATS)
    }
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
  // 主链路热路径：只更新内存缓存并标脏，落盘交给节流定时器合并执行，
  // 避免每条请求都对整快照做深拷贝 + 全量 normalize + 同步 JSON.stringify 写盘。
  const cache = await loadSnapshot()
  cache.logs.unshift(log)
  if (cache.logs.length > MAX_LOGS) cache.logs.length = MAX_LOGS
  const tokenStat = tokenStatFromLog(log)
  if (tokenStat) {
    cache.tokenStats.unshift(tokenStat)
    if (cache.tokenStats.length > MAX_TOKEN_STATS) cache.tokenStats.length = MAX_TOKEN_STATS
  }
  scheduleLogFlush()
  return cache
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
