export type ProtocolType =
  | "openai-responses"
  | "openai-chat"
  | "anthropic"
  | "gemini"

export type HealthStatus = "healthy" | "degraded" | "down"

export type ReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "auto"

export type TakeoverStatus = "active" | "paused"

export type WebSearchMode = "builtin" | "mcp" | "disabled"

export type ReasoningDialect =
  | "auto"
  | "none"
  | "openai-reasoning-effort"
  | "deepseek-official"
  | "openrouter-reasoning"
  | "qwen-enable-thinking"
  | "siliconflow-enable-thinking"
  | "kimi-thinking"
  | "glm-thinking"
  | "volcengine-thinking"
  | "minimax-reasoning-split"
  | "stepfun-low-high"
  | "tencent-tokenhub-thinking"
  | "workbuddy-effort"

export type ModelReasoningDialect = ReasoningDialect | "inherit"

export const REASONING_DIALECTS: ReasoningDialect[] = [
  "auto",
  "none",
  "openai-reasoning-effort",
  "deepseek-official",
  "openrouter-reasoning",
  "qwen-enable-thinking",
  "siliconflow-enable-thinking",
  "kimi-thinking",
  "glm-thinking",
  "volcengine-thinking",
  "minimax-reasoning-split",
  "stepfun-low-high",
  "tencent-tokenhub-thinking",
  "workbuddy-effort",
]

export interface HeaderEntry {
  id: string
  key: string
  value: string
}

export interface ProviderEndpoint {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  enabled: boolean
}

export interface Provider {
  id: string
  name: string
  protocol: ProtocolType
  endpoints: ProviderEndpoint[]
  headers: HeaderEntry[]
  bodyOverride: string
  timeoutMs: number
  reasoningDialect: ReasoningDialect
  rawResponsesPassthrough: boolean
  enabled: boolean
  isDefault: boolean
  health: HealthStatus
  healthMessage?: string
}

export interface ResolvedProvider extends Provider {
  baseUrl: string
  apiKey: string
  activeEndpointId: string
  activeEndpointName: string
}

export interface ProviderEndpointRuntimeState {
  providerId: string
  endpointId: string
  credentialFingerprint: string
  consecutiveFailures: number
  cooldownUntil?: string
  quotaDisabled: boolean
  authDisabled: boolean
  lastError?: string
  updatedAt: string
}

export interface Model {
  id: string
  providerId: string
  displayName: string
  modelId: string
  capabilities: string[]
  contextLength: number
  supportsReasoning: boolean
  reasoningDialect: ModelReasoningDialect
  supportsVision: boolean
  enabled: boolean
}

export interface ModelMapping {
  id: string
  codexModel: string
  targetProviderId: string
  targetModelId: string
  reasoningOverride: ReasoningEffort | "inherit"
  priority: number
  enabled: boolean
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  cacheUsageReported?: boolean
  reasoningTokens?: number
  upstreamCost?: TokenCost
}

export type TokenStatAggregation = "request" | "day" | "history"

export interface TokenCost {
  amount: number
  currency?: string
  source: "upstream"
}

export interface TokenStatEntry {
  id: string
  timestamp: string
  providerId: string
  modelId: string
  codexModel: string
  statusCode: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  cacheMeasuredCachedInputTokens: number
  cacheMeasuredInputTokens: number
  cacheMeasuredRequests: number
  reasoningTokens: number
  requestCount?: number
  aggregation?: TokenStatAggregation
  resetAt?: string
}

/**
 * 上游 Chat Completions 流的收尾事实快照。
 *
 * 只做记录：不参与任何转发判定，也不改变响应内容。之所以需要它，是因为
 * `chat_compatible` 路径下中转会自己补 `response.completed`，光看转发出去的流
 * 分辨不出「上游正常收尾」和「上游安静断开、中转代为收尾」；把上游给出的
 * finish_reason、是否真的收到终止帧、本轮是否停在进行中的 agentic 回合等原始
 * 事实落到日志里，事后才能复盘截断与半途收尾。
 */
export interface ChatStreamTruth {
  /** 上游流里显式给出的 finish_reason 原文；上游没给时为空串。 */
  upstreamFinishReason: string
  /** 中转最终采用的 finish_reason（含默认 stop 与中转补写的 length）。 */
  finalFinishReason: string
  /** finalFinishReason 的来源。 */
  finishReasonSource: "upstream" | "synthesized" | "none"
  /** 上游是否发出过带 choices 的帧。 */
  sawChoice: boolean
  /** 是否收到 [DONE] 终止帧。 */
  sawDoneFrame: boolean
  /** 本轮累积的具名工具调用数。 */
  toolCallCount: number
  /** 请求上下文末项的类型，function_call_output 表示这轮在接着工具结果续跑。 */
  lastInputItemType: string
  /** 流内累积的可见正文字符数。 */
  visibleChars: number
  /** 流内累积的推理字符数（含内联 think 内容）。 */
  reasoningChars: number
  /** 中转最终给出的响应状态。 */
  settledAs: "completed" | "incomplete" | "failed" | "aborted"
}

export interface RequestLog {
  id: string
  timestamp: string
  codexModel: string
  finalProviderId: string
  finalModelId: string
  finalEndpointId?: string
  finalEndpointName?: string
  attemptedEndpointIds?: string[]
  failoverReason?: string
  reasoning: ReasoningEffort
  statusCode: number
  durationMs: number
  stream?: boolean
  firstTokenMs?: number
  outputTokensPerSecond?: number
  tokenUsage?: TokenUsage
  error?: string
  rawRequest: string
  rewrittenRequest: string
  responseSummary: string
  errorStack?: string
  /** 仅 chat_compatible 流式路径有值：上游收尾事实快照。 */
  chatStreamTruth?: ChatStreamTruth
}

export interface RequestLogDetail {
  id: string
  rawRequest: string
  rewrittenRequest: string
  responseSummary: string
  hasFullRawRequest: boolean
  hasFullRewrittenRequest: boolean
}

export interface RuntimeConfig {
  takeover: TakeoverStatus
  activeProviderId: string
  activeModelId: string
  reasoning: ReasoningEffort
}

export interface FloatingBallPosition {
  x: number
  y: number
}

export interface Settings {
  listenAddress: string
  port: number
  takeoverEnabled: boolean
  defaultProviderId: string
  defaultModelId: string
  defaultReasoning: ReasoningEffort
  auxiliaryRoutingEnabled: boolean
  auxiliaryProviderId: string
  auxiliaryModelId: string
  auxiliaryReasoning: ReasoningEffort
  codexSubagentModelSlugs: string[]
  imageGenerationProviderId: string
  imageGenerationModelId: string
  logRetentionDays: number
  fullRequestLoggingEnabled: boolean
  webSearchMode: WebSearchMode
  keyStorage: string
  floatingBallEnabled: boolean
  floatingBallPosition?: FloatingBallPosition
  tokenStatsResetAt: string
}

export interface ConsoleSnapshot {
  version: number
  providers: Provider[]
  models: Model[]
  mappings: ModelMapping[]
  logs: RequestLog[]
  tokenStats: TokenStatEntry[]
  endpointStates: ProviderEndpointRuntimeState[]
  runtime: RuntimeConfig
  settings: Settings
}

export type RoutingSnapshot = Pick<
  ConsoleSnapshot,
  "providers" | "models" | "mappings" | "runtime" | "settings"
>

export interface ProviderTestResult {
  ok: boolean
  message: string
  provider?: Provider
}

export interface ModelTestResult {
  ok: boolean
  message: string
  durationMs: number
  providerId: string
  modelId: string
  statusCode?: number
  outputText?: string
  tokenUsage?: TokenUsage
}

export const PROTOCOL_LABELS: Record<ProtocolType, string> = {
  "openai-responses": "OpenAI Responses",
  "openai-chat": "OpenAI Chat Completions",
  anthropic: "Anthropic",
  gemini: "Gemini",
}

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
  ultra: "Ultra",
  auto: "自动",
}

export const REASONING_DIALECT_LABELS: Record<ReasoningDialect, string> = {
  auto: "自动推断",
  none: "不改写",
  "openai-reasoning-effort": "OpenAI reasoning_effort",
  "deepseek-official": "DeepSeek 官方",
  "openrouter-reasoning": "OpenRouter reasoning",
  "qwen-enable-thinking": "Qwen enable_thinking + thinking_budget",
  "siliconflow-enable-thinking": "硅基流动 enable_thinking",
  "kimi-thinking": "Kimi thinking",
  "glm-thinking": "GLM thinking",
  "volcengine-thinking": "火山方舟 thinking",
  "minimax-reasoning-split": "MiniMax reasoning_split",
  "stepfun-low-high": "StepFun reasoning_effort",
  "tencent-tokenhub-thinking": "腾讯 TokenHub thinking",
  "workbuddy-effort": "WorkBuddy reasoning_effort",
}

export const HEALTH_LABELS: Record<HealthStatus, string> = {
  healthy: "正常",
  degraded: "降级",
  down: "不可用",
}
