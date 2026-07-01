import "server-only"

import type { ReasoningDialect, ReasoningEffort } from "@/lib/types"
import type { ProxyTarget } from "./common"

type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function isOpenAIOModel(model: string) {
  return /^o\d/i.test(model)
}

function supportsGlmReasoningEffort(model: string) {
  const normalized = model.toLowerCase()
  const match = normalized.match(/\bglm-(\d+)(?:\.(\d+))?/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] || 0)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  return major > 5 || (major === 5 && minor >= 2)
}

function isGlmModel(model: string) {
  return /\bglm[-/]/i.test(model) || /(?:^|\/)zhipuai\/glm/i.test(model)
}

function isDeepSeekV4Model(model: string) {
  return /(?:^|[/-])deepseek-v4(?:[/-]|$)/i.test(model)
}

function inferChatReasoningDialect(target: ProxyTarget): ReasoningDialect {
  const lower = target.modelId.toLowerCase()
  if (lower.includes("openrouter") || lower.startsWith("openrouter/")) return "openrouter-reasoning"
  if (lower.includes("deepseek")) return "deepseek-official"
  if (
    lower.includes("qwen") ||
    lower.includes("qwq") ||
    lower.includes("qvq") ||
    lower.includes("dashscope") ||
    lower.includes("bailian")
  ) {
    return "qwen-enable-thinking"
  }
  if (lower.includes("siliconflow")) return "siliconflow-enable-thinking"
  if (lower.includes("kimi") || lower.includes("moonshot")) return "kimi-thinking"
  if (
    lower.includes("glm") ||
    lower.includes("zhipu") ||
    lower.includes("z.ai") ||
    lower.includes("mimo")
  ) {
    return "glm-thinking"
  }
  if (lower.includes("doubao") || lower.includes("volcengine") || lower.includes("volces")) {
    return "volcengine-thinking"
  }
  if (lower.includes("minimax")) return "minimax-reasoning-split"
  if (lower.includes("stepfun") || lower.startsWith("step-")) {
    return "stepfun-low-high"
  }
  if (lower.includes("hunyuan") || lower.startsWith("hy")) return "tencent-tokenhub-thinking"
  if (isOpenAIOModel(lower) || /^gpt-[5-9]/.test(lower)) {
    return "openai-reasoning-effort"
  }

  const providerHint = `${target.provider.name} ${target.provider.baseUrl} ${target.provider.protocol}`.toLowerCase()
  if (providerHint.includes("openrouter")) return "openrouter-reasoning"
  if (providerHint.includes("siliconflow")) return "siliconflow-enable-thinking"
  if (
    providerHint.includes("qwen") ||
    providerHint.includes("dashscope") ||
    providerHint.includes("bailian") ||
    providerHint.includes("百炼") ||
    providerHint.includes("千问")
  ) {
    return "qwen-enable-thinking"
  }
  if (providerHint.includes("deepseek")) return "deepseek-official"
  if (providerHint.includes("minimax")) return "minimax-reasoning-split"
  if (providerHint.includes("stepfun")) return "stepfun-low-high"
  if (providerHint.includes("hunyuan") || providerHint.includes("tencent")) return "tencent-tokenhub-thinking"
  if (
    providerHint.includes("glm") ||
    providerHint.includes("zhipu") ||
    providerHint.includes("z.ai") ||
    providerHint.includes("bigmodel") ||
    providerHint.includes("智谱") ||
    providerHint.includes("mimo")
  ) {
    return "glm-thinking"
  }

  return "none"
}

export function resolveReasoningDialect(target: ProxyTarget): ReasoningDialect {
  const modelDialect = target.model?.reasoningDialect
  if (modelDialect && modelDialect !== "inherit" && modelDialect !== "auto") {
    return modelDialect
  }
  return inferChatReasoningDialect(target)
}

function reasoningRequested(body: AnyRecord) {
  const effort = safeTrim(body.reasoning?.effort || body.reasoning_effort).toLowerCase()
  if (effort) return !["none", "off", "disabled"].includes(effort)
  if (Object.hasOwn(body, "reasoning")) return body.reasoning != null
  return undefined
}

function mapReasoningEffort(effort: string, dialect: ReasoningDialect) {
  const normalized = effort.trim().toLowerCase()
  if (["none", "off", "disabled", "auto"].includes(normalized)) return undefined

  if (dialect === "deepseek-official") {
    return normalized === "max" || normalized === "xhigh" ? "max" : "high"
  }
  if (dialect === "stepfun-low-high") {
    if (normalized === "minimal" || normalized === "low") return "low"
    return "high"
  }
  if (dialect === "openrouter-reasoning") {
    if (normalized === "max" || normalized === "xhigh") return "xhigh"
    return ["high", "medium", "low", "minimal"].includes(normalized)
      ? normalized
      : undefined
  }
  if (dialect === "openai-reasoning-effort" || dialect === "volcengine-thinking") {
    if (normalized === "xhigh") return "max"
    return ["minimal", "low", "medium", "high", "max"].includes(normalized)
      ? normalized
      : undefined
  }
  return ["minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized)
    ? normalized
    : undefined
}

function mapThinkingBudget(effort: string) {
  const normalized = effort.trim().toLowerCase()
  if (normalized === "minimal" || normalized === "low") return 1024
  if (normalized === "high" || normalized === "xhigh" || normalized === "max") return 8192
  return 4096
}

function mapQwenThinkingBudget(effort: string) {
  const normalized = effort.trim().toLowerCase()
  if (normalized === "minimal" || normalized === "low") return 1024
  if (normalized === "medium") return 4096
  if (normalized === "high") return 8192
  if (normalized === "xhigh" || normalized === "max") return 16384
  return 4096
}

export function clearChatReasoningOptions(body: AnyRecord) {
  delete body.reasoning
  delete body.reasoning_effort
  delete body.thinking
  delete body.enable_thinking
  delete body.reasoning_split
  delete body.thinking_budget
}

export function applyChatReasoningOptions(
  result: AnyRecord,
  body: AnyRecord,
  dialect: ReasoningDialect,
  model = "",
) {
  if (dialect === "none") return

  const enabled = reasoningRequested(body)
  if (enabled == null) return

  if (
    dialect === "deepseek-official" ||
    dialect === "kimi-thinking" ||
    dialect === "glm-thinking" ||
    dialect === "volcengine-thinking"
  ) {
    result.thinking = { type: enabled ? "enabled" : "disabled" }
  }
  if (enabled && dialect === "glm-thinking" && isGlmModel(model) && isObject(result.thinking)) {
    result.thinking.clear_thinking = false
  }
  if (dialect === "qwen-enable-thinking" || dialect === "siliconflow-enable-thinking") {
    result.enable_thinking = enabled
  }
  if (dialect === "minimax-reasoning-split") result.reasoning_split = enabled
  if (dialect === "tencent-tokenhub-thinking") {
    result.thinking = { type: enabled ? "enabled" : "disabled" }
  }

  if (!enabled) {
    if (dialect === "openrouter-reasoning") result.reasoning = { effort: "none" }
    return
  }

  const effort = safeTrim(body.reasoning?.effort || body.reasoning_effort)
  if (!effort) return

  const mapped = mapReasoningEffort(effort, dialect)
  if (!mapped) return

  if (dialect === "openrouter-reasoning") {
    result.reasoning = { effort: mapped }
  } else if (
    dialect === "openai-reasoning-effort" ||
    dialect === "deepseek-official" ||
    dialect === "volcengine-thinking" ||
    dialect === "stepfun-low-high" ||
    dialect === "tencent-tokenhub-thinking"
  ) {
    result.reasoning_effort = mapped
  }
  if (dialect === "siliconflow-enable-thinking") {
    result.thinking_budget = mapThinkingBudget(effort)
  } else if (dialect === "qwen-enable-thinking") {
    if (isDeepSeekV4Model(model)) {
      const deepSeekEffort = mapReasoningEffort(effort, "deepseek-official")
      if (deepSeekEffort) result.reasoning_effort = deepSeekEffort
    } else {
      result.thinking_budget = mapQwenThinkingBudget(effort)
    }
  }
}

export function applyChatPassthroughReasoningOverride(
  body: AnyRecord,
  dialect: ReasoningDialect,
  reasoning: ReasoningEffort,
  model = "",
) {
  if (reasoning === "auto") return
  clearChatReasoningOptions(body)
  applyChatReasoningOptions(body, { reasoning: { effort: reasoning } }, dialect, model)
}

export function setCanonicalReasoning(body: AnyRecord, reasoning: ReasoningEffort) {
  if (reasoning === "auto") return
  body.reasoning = isObject(body.reasoning)
    ? { ...body.reasoning, effort: reasoning }
    : { effort: reasoning }
}
