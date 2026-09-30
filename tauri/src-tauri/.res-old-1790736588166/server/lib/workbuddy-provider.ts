import { createProviderEndpoint } from "@/lib/provider-endpoints"
import type { DiscoveredModel } from "@/lib/provider-model-discovery"
import type { Model, Provider } from "@/lib/types"

/**
 * WorkBuddy（腾讯 CodeBuddy 桌面端）本机账号上游。
 *
 * 上游是 OpenAI Chat 兼容的 SSE 接口，只接受 `stream: true`；鉴权用桌面端写在
 * `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` 里的
 * 登录态，所以这个供应商是内置的：不需要填 Key，也不该手改地址。状态里存的是占位
 * Key，真实 token 每次请求时由 `lib/server/workbuddy/upstream.ts` 从本机登录态注入。
 */
export const WORKBUDDY_PROVIDER_ID = "prov-workbuddy"
export const WORKBUDDY_ENDPOINT_ID = "prov-workbuddy-local"
// 上游 chat 接口是 `{base}/chat/completions`，所以这里停在版本段上。
export const WORKBUDDY_API_BASE_URL = "https://www.codebuddy.cn/v2"
export const WORKBUDDY_CREDENTIAL_PLACEHOLDER = "workbuddy-local-account"
export const WORKBUDDY_REASONING_DIALECT = "workbuddy-effort" as const

/**
 * 国际站（www.workbuddy.ai）realm。
 *
 * 与国内站共用 `/v2/plugin/auth/*` 设备授权流与 chat 接口，但上游口径不同。以下口径
 * 直接对照开源实现 `ErfanBagheri404/WorkBuddy2API`（`auth.go` / `upstream.go`）：
 * - 设备流平台标识 `workbuddy-ai`（国内站是 `CLI`）；
 * - 模型目录在 `GET /v2/enterprises/personal/models`（国内站是站点根的 `/v3/config`）；
 * - 上游请求头与国内站一致（`X-Product: SaaS` + `X-User-Id` + `X-Domain`）。
 */
export const WORKBUDDY_GLOBAL_PROVIDER_ID = "prov-workbuddy-global"
export const WORKBUDDY_GLOBAL_ENDPOINT_ID = "prov-workbuddy-global-primary"
export const WORKBUDDY_GLOBAL_API_BASE_URL = "https://www.workbuddy.ai/v2"
export const WORKBUDDY_GLOBAL_CREDENTIAL_PLACEHOLDER = "workbuddy-global-account"
export const WORKBUDDY_GLOBAL_PLATFORM = "workbuddy-ai"

/** 上游 realm：国内站 `cn` / 国际站 `global`。 */
export type WorkbuddyRealm = "cn" | "global"

const WORKBUDDY_GLOBAL_HOSTS = new Set(["www.workbuddy.ai", "workbuddy.ai"])

/** 上游按 User-Agent 认 CodeBuddy CLI 版本，缺了会直接拒掉配置接口。 */
export const WORKBUDDY_CLI_VERSION = "2.137.1"
export const WORKBUDDY_USER_AGENT = `CLI/${WORKBUDDY_CLI_VERSION} CodeBuddy/${WORKBUDDY_CLI_VERSION}`

/** 桌面端登录态可能落在国际站域名上，那一侧要用自己的来源站点。 */
const WORKBUDDY_API_HOSTS = new Set([
  "www.codebuddy.cn",
  "codebuddy.cn",
  "copilot.tencent.com",
  "www.workbuddy.ai",
  "workbuddy.ai",
  "www.workbuddy.cn",
  "workbuddy.cn",
])

const WORKBUDDY_MODEL_IDS = [
  "hy4-preview",
  "hy4-preview-x",
  "hy3",
  "hy3-x",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "glm-5.1",
  "glm-5v-turbo",
  "minimax-m3",
  "minimax-m2.7",
  "kimi-k3-1",
  "kimi-k2.8-preview",
  "kimi-k2.7",
  "kimi-k2.6",
] as const

/**
 * 内置 WorkBuddy 模型对 Codex 报的上下文上限。
 *
 * 上游目录把它那批模型写成 100 万，但账号侧实际给不了那么大：请求堆到 35 万 token 上下
 * 之后多次出现「模型只吐一句计划、不返回 tool_calls」的软失败——上游不报错、也不截断，
 * 只是工具调用静默消失，Codex 那边就当成回合正常结束，看起来就是任务做到一半断了。
 * 这里按上游实际可用容量铺底，让 Codex 早一点压缩，而不是等到 40 万 token 才动。
 */
export const WORKBUDDY_MAX_CONTEXT_LENGTH = 272_000

/** 目录与状态里的上下文长度统一压到上限，避免把 100 万直接透给 Codex。 */
export function clampWorkbuddyContextLength(value: number) {
  return value > WORKBUDDY_MAX_CONTEXT_LENGTH ? WORKBUDDY_MAX_CONTEXT_LENGTH : value
}

/**
 * 内置供应商的初始模型。
 *
 * 名单取自上游 `/v3/config` 里 `agents[cli].models`（也就是它给自己 CLI Agent 开的那批
 * craft 模型），字段同样来自该接口的 `models[]`。控制台里「获取模型」会按同一接口把
 * 账号可用的完整名单拉回来，用户想用别的模型不用改代码。
 */
const WORKBUDDY_PRESET_MODELS: Array<{
  displayName: string
  modelId: string
  contextLength: number
  supportsReasoning: boolean
  supportsVision: boolean
}> = [
  { displayName: "Hy4 Preview", modelId: "hy4-preview", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "Hy4 Preview X", modelId: "hy4-preview-x", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "Hy3", modelId: "hy3", contextLength: 192_000, supportsReasoning: true, supportsVision: true },
  { displayName: "Hy3 X", modelId: "hy3-x", contextLength: 192_000, supportsReasoning: true, supportsVision: true },
  { displayName: "DeepSeek V4 Pro", modelId: "deepseek-v4-pro", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "DeepSeek V4.1 Flash", modelId: "deepseek-v4.1-flash", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "GLM 5.3", modelId: "glm-5.3", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "GLM 5.3 Flash", modelId: "glm-5.3-flash", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "GLM 5.2", modelId: "glm-5.2", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "GLM 5.1", modelId: "glm-5.1", contextLength: 200_000, supportsReasoning: true, supportsVision: true },
  { displayName: "GLM 5V Turbo", modelId: "glm-5v-turbo", contextLength: 200_000, supportsReasoning: true, supportsVision: true },
  { displayName: "MiniMax M3", modelId: "minimax-m3", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "MiniMax M2.7", modelId: "minimax-m2.7", contextLength: 200_000, supportsReasoning: true, supportsVision: true },
  { displayName: "Kimi K3", modelId: "kimi-k3-1", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "Kimi K2.8 Preview", modelId: "kimi-k2.8-preview", contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH, supportsReasoning: true, supportsVision: true },
  { displayName: "Kimi K2.7 Code", modelId: "kimi-k2.7", contextLength: 256_000, supportsReasoning: true, supportsVision: true },
  { displayName: "Kimi K2.6", modelId: "kimi-k2.6", contextLength: 256_000, supportsReasoning: true, supportsVision: true },
]

export function workbuddyModelId(modelId: string) {
  return `m-workbuddy-${modelId.replace(/[^a-zA-Z0-9]+/g, "-")}`
}

export function workbuddyPresetModelIds(): string[] {
  return [...WORKBUDDY_MODEL_IDS]
}

/** 预设模型规格（不含 providerId / 生成 id），供内置供应商与预设供应商共用。 */
export interface WorkbuddyPresetModelSpec {
  displayName: string
  modelId: string
  contextLength: number
  supportsReasoning: boolean
  supportsVision: boolean
}

export function workbuddyPresetModelSpecs(): WorkbuddyPresetModelSpec[] {
  return WORKBUDDY_PRESET_MODELS.map((preset) => ({ ...preset }))
}

/** 供应商是否指向 WorkBuddy 上游：内置 id 或任一已知官方域名。 */
export function isWorkbuddyProvider(
  provider: Pick<Provider, "id" | "endpoints">,
): boolean {
  if (provider.id === WORKBUDDY_PROVIDER_ID) return true
  if (provider.id === WORKBUDDY_GLOBAL_PROVIDER_ID) return true
  return provider.endpoints.some((endpoint) => isWorkbuddyBaseUrl(endpoint.baseUrl))
}

export function isWorkbuddyBaseUrl(baseUrl: string) {
  const host = hostnameOf(baseUrl)
  return host ? WORKBUDDY_API_HOSTS.has(host) : false
}

/** 按 baseUrl 判定 realm；未知域名一律当国内站（保持既有行为）。 */
export function workbuddyRealmOf(baseUrl: string): WorkbuddyRealm {
  return WORKBUDDY_GLOBAL_HOSTS.has(hostnameOf(baseUrl)) ? "global" : "cn"
}

/** 供应商级别的 realm：显式国际版内置 id，或任一端点落在国际站域。 */
export function workbuddyRealmOfProvider(
  provider: Pick<Provider, "id" | "endpoints">,
): WorkbuddyRealm {
  if (provider.id === WORKBUDDY_GLOBAL_PROVIDER_ID) return "global"
  return provider.endpoints.some((endpoint) => workbuddyRealmOf(endpoint.baseUrl) === "global")
    ? "global"
    : "cn"
}

/**
 * 上游账号/模型目录接口，两个 realm 路径不同：
 * - 国内站：站点根上的 `/v3/config`（与桌面端配置接口同一份数据）；
 * - 国际站：`/v2/enterprises/personal/models`（对照 WorkBuddy2API `upstream.go`）。
 */
export function workbuddyCatalogUrl(baseUrl: string) {
  const url = new URL(baseUrl.trim() || WORKBUDDY_API_BASE_URL)
  if (workbuddyRealmOf(baseUrl) === "global") {
    return `${url.origin}/v2/enterprises/personal/models`
  }
  return `${url.origin}/v3/config`
}

export function workbuddySiteUrl(baseUrl: string) {
  return new URL(baseUrl.trim() || WORKBUDDY_API_BASE_URL).origin
}

function hostnameOf(baseUrl: string) {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ""
  try {
    return new URL(trimmed).hostname.toLowerCase()
  } catch {
    return ""
  }
}

export function workbuddyProviderTemplate(): Provider {
  return {
    id: WORKBUDDY_PROVIDER_ID,
    name: "WorkBuddy 本机账号",
    protocol: "openai-chat",
    endpoints: [
      createProviderEndpoint(WORKBUDDY_PROVIDER_ID, {
        id: WORKBUDDY_ENDPOINT_ID,
        name: "本机登录态",
        baseUrl: WORKBUDDY_API_BASE_URL,
        apiKey: WORKBUDDY_CREDENTIAL_PLACEHOLDER,
      }),
    ],
    headers: workbuddyStaticHeaders(),
    bodyOverride: "",
    timeoutMs: 180_000,
    reasoningDialect: WORKBUDDY_REASONING_DIALECT,
    rawResponsesPassthrough: false,
    enabled: true,
    isDefault: false,
    health: "healthy",
  }
}

/**
 * 国际版（www.workbuddy.ai）供应商模板。
 *
 * 与国内版并列的独立供应商：地址停在 `https://www.workbuddy.ai/v2`，凭据同样由
 * `lib/server/workbuddy/upstream.ts` 在请求时从**国际版号池**注入，所以状态里只存占位 Key。
 */
export function workbuddyGlobalProviderTemplate(): Provider {
  return {
    id: WORKBUDDY_GLOBAL_PROVIDER_ID,
    name: "WorkBuddy 国际账号",
    protocol: "openai-chat",
    endpoints: [
      createProviderEndpoint(WORKBUDDY_GLOBAL_PROVIDER_ID, {
        id: WORKBUDDY_GLOBAL_ENDPOINT_ID,
        name: "国际站登录态",
        baseUrl: WORKBUDDY_GLOBAL_API_BASE_URL,
        apiKey: WORKBUDDY_GLOBAL_CREDENTIAL_PLACEHOLDER,
      }),
    ],
    headers: workbuddyStaticHeaders(),
    bodyOverride: "",
    timeoutMs: 180_000,
    reasoningDialect: WORKBUDDY_REASONING_DIALECT,
    rawResponsesPassthrough: false,
    enabled: true,
    isDefault: false,
    health: "healthy",
  }
}

/**
 * 官方客户端会带的一批固定头。桌面端登录态相关的 `X-User-Id`、`X-Domain` 不在这里，
 * 它们随 token 一起在请求时注入。
 */
export function workbuddyStaticHeaders(): Provider["headers"] {
  return [
    { id: "workbuddy-user-agent", key: "user-agent", value: WORKBUDDY_USER_AGENT },
    { id: "workbuddy-agent-intent", key: "X-Agent-Intent", value: "craft" },
    { id: "workbuddy-ide-name", key: "X-IDE-Name", value: "CLI" },
    { id: "workbuddy-ide-type", key: "X-IDE-Type", value: "CLI" },
    { id: "workbuddy-ide-version", key: "X-IDE-Version", value: WORKBUDDY_CLI_VERSION },
    { id: "workbuddy-client-platform", key: "X-Client-Platform", value: "web" },
    { id: "workbuddy-product", key: "X-Product", value: "SaaS" },
    { id: "workbuddy-product-version", key: "X-Product-Version", value: WORKBUDDY_CLI_VERSION },
    { id: "workbuddy-requested-with", key: "X-Requested-With", value: "XMLHttpRequest" },
  ]
}

export function workbuddyPresetModels(): Model[] {
  return workbuddyPresetModelSpecs().map((preset) => ({
    id: workbuddyModelId(preset.modelId),
    providerId: WORKBUDDY_PROVIDER_ID,
    displayName: preset.displayName,
    modelId: preset.modelId,
    capabilities: [
      "chat",
      ...(preset.supportsReasoning ? ["reasoning"] : []),
      ...(preset.supportsVision ? ["vision"] : []),
      "tools",
    ],
    contextLength: clampWorkbuddyContextLength(preset.contextLength),
    supportsReasoning: preset.supportsReasoning,
    reasoningDialect: WORKBUDDY_REASONING_DIALECT,
    supportsVision: preset.supportsVision,
    enabled: true,
  }))
}

/**
 * 内置供应商与内置模型的铺底版本。
 *
 * 早于它的状态（老数据）补一次内置供应商和内置模型；从它开始，状态里存的是什么就是
 * 什么——用户删掉、停用、改地址都算数，不再被代码改回来。
 */
export const WORKBUDDY_SEED_STATE_VERSION = 3

export function seedWorkbuddyBuiltin(
  providers: Provider[],
  models: Model[],
  stateVersion: number,
): { providers: Provider[]; models: Model[] } {
  if (stateVersion >= WORKBUDDY_SEED_STATE_VERSION) return { providers, models }
  const hasProvider = providers.some(
    (provider) => provider.id === WORKBUDDY_PROVIDER_ID,
  )
  if (hasProvider) return { providers, models }
  return {
    providers: [...providers, workbuddyProviderTemplate()],
    models: [...models, ...workbuddyPresetModels()],
  }
}

/**
 * 上游模型目录的响应信封。
 *
 * 两个 realm 都是 `{ code, data: { models: [...] } }`，`code === 0` 才算成功；
 * 失败时把上游的 message 带出来（对照 WorkBuddy2API `upstream.go` 的 `envelope.Code != 0`）。
 * 国内站 `/v3/config` 不带 `code`，这时返回空串、不拦截。
 */
export function workbuddyCatalogError(payload: unknown): string {
  const root = asRecord(payload)
  const code = root.code
  if (typeof code !== "number" || code === 0) return ""
  const message = asString(root.message) || asString(root.msg) || asString(root.error)
  return message ? `上游返回 code=${code}：${message}` : `上游返回 code=${code}`
}

/**
 * 国际站 `/v2/enterprises/personal/models` 里**没有**、但 `/v2/chat/completions`
 * 直接认的模型名（对照 WorkBuddy2API `upstream.go` 的 `extraModels`）。
 */
const WORKBUDDY_GLOBAL_EXTRA_MODELS: Array<{ id: string; displayName: string }> = [
  { id: "deepseek-v4.1-flash", displayName: "DeepSeek-V4.1-Flash" },
  { id: "deepseek-v3", displayName: "DeepSeek-V3" },
]

/** 目录条目转成通用模型条目。 */
function toDiscoveredModel(record: Record<string, unknown>): DiscoveredModel | null {
  const id = asString(record.id)
  if (!id) return null
  const contextLength = asNumber(record.maxInputTokens)
  if (contextLength <= 0) return null
  return {
    id,
    displayName: asString(record.name) || id,
    contextLength: clampWorkbuddyContextLength(contextLength),
    supportsReasoning: record.supportsReasoning === true,
    supportsVision: record.supportsImages === true,
    supportsTools: record.supportsToolCall === true,
  }
}

/**
 * `/v3/config`（国内站）与 `/v2/enterprises/personal/models`（国际站）的
 * `data.models[]` 转成通用模型条目。
 *
 * 只保留带 token 上限的条目：上游把纯生图模型（`hunyuan-image-alpha` 之类）也放在同一份
 * 列表里，但它们没有上下文长度，也走不了 chat 接口。
 *
 * 国际站额外并入 `extraModels`：那批模型 chat 接口直接认，但目录里不列（对照
 * WorkBuddy2API `upstream.go`），不补的话在控制台里看不到。
 */
export function workbuddyCatalogModels(
  payload: unknown,
  realm: WorkbuddyRealm = "cn",
): DiscoveredModel[] {
  const models = asRecord(asRecord(payload).data).models
  if (!Array.isArray(models)) return []
  const seen = new Set<string>()
  const discovered: DiscoveredModel[] = []
  for (const entry of models) {
    const record = asRecord(entry)
    if (record.disabled === true) continue
    const model = toDiscoveredModel(record)
    if (!model || seen.has(model.id.toLowerCase())) continue
    seen.add(model.id.toLowerCase())
    discovered.push(model)
  }

  if (realm === "global") {
    for (const extra of WORKBUDDY_GLOBAL_EXTRA_MODELS) {
      if (seen.has(extra.id.toLowerCase())) continue
      seen.add(extra.id.toLowerCase())
      discovered.push({
        id: extra.id,
        displayName: extra.displayName,
        contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH,
        supportsReasoning: true,
        supportsVision: false,
        supportsTools: true,
      })
    }
  }

  return discovered
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value)
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.round(parsed) : 0
  }
  return 0
}
