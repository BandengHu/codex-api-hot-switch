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
  | "auto"

export type TakeoverStatus = "active" | "paused"

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
]

export interface HeaderEntry {
  id: string
  key: string
  value: string
}

export interface Provider {
  id: string
  name: string
  protocol: ProtocolType
  baseUrl: string
  apiKey: string
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
  reasoningTokens?: number
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
  reasoningTokens: number
}

export interface RequestLog {
  id: string
  timestamp: string
  codexModel: string
  finalProviderId: string
  finalModelId: string
  reasoning: ReasoningEffort
  statusCode: number
  durationMs: number
  tokenUsage?: TokenUsage
  error?: string
  rawRequest: string
  rewrittenRequest: string
  responseSummary: string
  errorStack?: string
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
  imageGenerationProviderId: string
  imageGenerationModelId: string
  logRetentionDays: number
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
  minimal: "低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "超高",
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
}

export const HEALTH_LABELS: Record<HealthStatus, string> = {
  healthy: "正常",
  degraded: "降级",
  down: "不可用",
}
