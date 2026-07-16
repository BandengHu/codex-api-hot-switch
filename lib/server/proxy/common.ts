import "server-only"

import { isChatModel } from "@/lib/model-capabilities"
import {
  CODEX_AUTO_MODEL_SLUG,
  resolveCodexRoutedModel,
} from "@/lib/server/codex-model-catalog"
import type {
  Model,
  Provider,
  ProtocolType,
  ReasoningEffort,
  RoutingSnapshot,
} from "@/lib/types"

export interface ProxyTarget {
  provider: Provider
  model?: Model
  modelId: string
  requestedModel: string
  reasoning: ReasoningEffort
  mappingId?: string
  paused: boolean
  fullRequestLoggingEnabled?: boolean
}

export function joinUrl(baseUrl: string, path: string) {
  const base = baseUrl.trim().replace(/#+$/, "").replace(/\/+$/, "")
  return `${base}/${path.replace(/^\/+/, "")}`
}

const LOG_PREVIEW_MAX_CHARS = 4000
const LOG_PREVIEW_MAX_STRING_CHARS = 600
const LOG_PREVIEW_MAX_DEPTH = 6
const LOG_PREVIEW_MAX_ARRAY_ITEMS = 16
const LOG_PREVIEW_MAX_OBJECT_KEYS = 32
const LOG_PREVIEW_MAX_NODES = 700

function truncateText(value: string, maxChars = LOG_PREVIEW_MAX_STRING_CHARS) {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`
}

function previewJsonValue(
  value: unknown,
  state: { nodes: number; seen: WeakSet<object> },
  depth = 0,
): unknown {
  state.nodes += 1
  if (state.nodes > LOG_PREVIEW_MAX_NODES) return "[truncated: node limit reached]"

  if (typeof value === "string") return truncateText(value)
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value
  }
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "undefined") return "[undefined]"
  if (typeof value === "function") return "[function]"
  if (typeof value === "symbol") return value.toString()
  if (typeof value !== "object") return String(value)

  if (state.seen.has(value)) return "[circular]"
  if (depth >= LOG_PREVIEW_MAX_DEPTH) {
    return Array.isArray(value)
      ? `[array depth limit, length=${value.length}]`
      : "[object depth limit]"
  }

  state.seen.add(value)
  if (Array.isArray(value)) {
    const items = value
      .slice(0, LOG_PREVIEW_MAX_ARRAY_ITEMS)
      .map((item) => previewJsonValue(item, state, depth + 1))
    if (value.length > LOG_PREVIEW_MAX_ARRAY_ITEMS) {
      items.push(`[truncated ${value.length - LOG_PREVIEW_MAX_ARRAY_ITEMS} items]`)
    }
    return items
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const preview: Record<string, unknown> = {}
  for (const key of keys.slice(0, LOG_PREVIEW_MAX_OBJECT_KEYS)) {
    preview[key] = previewJsonValue(record[key], state, depth + 1)
  }
  if (keys.length > LOG_PREVIEW_MAX_OBJECT_KEYS) {
    preview.__truncated_keys__ = keys.length - LOG_PREVIEW_MAX_OBJECT_KEYS
  }
  return preview
}

export function compactJson(value: unknown) {
  const preview = previewJsonValue(value, {
    nodes: 0,
    seen: new WeakSet<object>(),
  })
  const text = JSON.stringify(preview, null, 2)
  return text.length > LOG_PREVIEW_MAX_CHARS
    ? `${text.slice(0, LOG_PREVIEW_MAX_CHARS)}... [log preview truncated]`
    : text
}

export function responseId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`
}

export function isOpenAIResponsesProtocol(protocol: ProtocolType) {
  return protocol === "openai-responses"
}

export function isOpenAIChatProtocol(protocol: ProtocolType) {
  return protocol === "openai-chat"
}

export function isResponsesPath(path: string) {
  const normalized = path.replace(/^\/+/, "").split("?")[0]
  return /(^|\/)responses$/.test(normalized)
}

export function isResponsesCompactPath(path: string) {
  const normalized = path.replace(/^\/+/, "").split("?")[0]
  return /(^|\/)responses\/compact$/.test(normalized)
}

export function isChatCompletionsPath(path: string) {
  const normalized = path.replace(/^\/+/, "").split("?")[0]
  return /(^|\/)chat\/completions$/.test(normalized)
}

export function extractRequestedModel(body: unknown) {
  if (body && typeof body === "object" && "model" in body) {
    const model = (body as { model?: unknown }).model
    if (typeof model === "string" && model.trim()) return model
  }
  return "unknown"
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultra" ||
    value === "auto"
  )
}

export function extractReasoning(body: unknown): ReasoningEffort {
  if (!body || typeof body !== "object") return "off"
  const record = body as Record<string, unknown>
  const reasoning = record.reasoning
  if (reasoning && typeof reasoning === "object") {
    const effort = (reasoning as Record<string, unknown>).effort
    if (isReasoningEffort(effort)) return effort
  }
  const legacyEffort = record.reasoning_effort
  if (isReasoningEffort(legacyEffort)) return legacyEffort
  return "off"
}

export function resolveTarget(
  snapshot: RoutingSnapshot,
  body: unknown,
): ProxyTarget {
  const requestedModel = extractRequestedModel(body)
  const paused = snapshot.runtime.takeover !== "active"

  const routed = resolveCodexRoutedModel(snapshot, requestedModel)
  if (routed) {
    const reasoning = extractReasoning(body)
    return {
      provider: routed.provider,
      model: routed.model,
      modelId: routed.model.modelId,
      requestedModel,
      reasoning: routed.model.supportsReasoning ? reasoning : "off",
      paused: false,
    }
  }

  if (paused) {
    if (requestedModel === CODEX_AUTO_MODEL_SLUG) {
      throw new Error("接管暂停时不能使用「自动」模型；请启用接管或在 Codex 中选择具体模型")
    }
    const provider = snapshot.providers.find(
      (p) => p.id === snapshot.settings.defaultProviderId,
    )
    if (!provider) throw new Error("接管已暂停，但默认供应商不存在")
    return {
      provider,
      modelId: requestedModel,
      requestedModel,
      reasoning: extractReasoning(body),
      paused,
    }
  }

  const mapping = [...snapshot.mappings]
    .filter((m) => m.enabled && m.codexModel === requestedModel)
    .sort((a, b) => a.priority - b.priority)[0]

  if (mapping) {
    const provider = snapshot.providers.find((p) => p.id === mapping.targetProviderId)
    const model = snapshot.models.find((m) => m.id === mapping.targetModelId)
    if (!provider) throw new Error(`映射 ${mapping.id} 指向的供应商不存在`)
    if (!model) throw new Error(`映射 ${mapping.id} 指向的模型不存在`)
    if (model.providerId !== provider.id) {
      throw new Error(`映射 ${mapping.id} 的供应商与模型不匹配`)
    }
    if (!isChatModel(model)) throw new Error(`映射 ${mapping.id} 指向的模型不是聊天模型`)
    const mappingReasoning =
      mapping.reasoningOverride === "inherit"
        ? extractReasoning(body)
        : mapping.reasoningOverride
    return {
      provider,
      model,
      modelId: model.modelId,
      requestedModel,
      reasoning: model.supportsReasoning ? mappingReasoning : "off",
      mappingId: mapping.id,
      paused,
    }
  }

  const provider = snapshot.providers.find(
    (p) => p.id === snapshot.runtime.activeProviderId,
  )
  const model = snapshot.models.find((m) => m.id === snapshot.runtime.activeModelId)
  if (!provider) throw new Error("当前热切换供应商不存在")
  if (!model) throw new Error("当前热切换模型不存在")
  if (model.providerId !== provider.id) throw new Error("当前热切换供应商与模型不匹配")
  if (!isChatModel(model)) throw new Error("当前热切换模型不是聊天模型")
  return {
    provider,
    model,
    modelId: model.modelId,
    requestedModel,
    reasoning: model.supportsReasoning ? snapshot.runtime.reasoning : "off",
    paused,
  }
}

export function providerHeaders(provider: Provider, extra?: HeadersInit): Headers {
  const headers = new Headers(extra)
  for (const entry of provider.headers) {
    const key = entry.key.trim()
    if (!key) continue
    if (key.toLowerCase() === "accept-encoding") continue
    headers.set(key, entry.value)
  }
  if (provider.apiKey.trim()) {
    if (provider.protocol === "anthropic") {
      headers.set("x-api-key", provider.apiKey.trim())
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", "2023-06-01")
      }
    } else if (provider.protocol !== "gemini") {
      headers.set("authorization", `Bearer ${provider.apiKey.trim()}`)
    }
  }
  return headers
}

// Codex 桌面端靠 assistant message 上的 phase 字段决定是否折叠：
// commentary = 回合中途的前导/进度叙述（可折叠），final_answer = 回合最终答案（展开）。
// 该字段只有 gpt-5.3-codex 及以后的模型才会原生下发，Claude / chat 上游不带，
// 因此中转按「这条 message 后面是否还有工具调用」补齐，使非 GPT 模型也能正确折叠。
function isAssistantMessageItem(item: unknown): item is Record<string, unknown> {
  if (!item || typeof item !== "object") return false
  const record = item as Record<string, unknown>
  if (record.type !== "message") return false
  const role = record.role
  return role == null || role === "assistant"
}

function isToolCallItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false
  const type = (item as Record<string, unknown>).type
  return (
    type === "function_call" ||
    type === "custom_tool_call" ||
    type === "tool_search_call" ||
    type === "local_shell_call"
  )
}

// 给一组 Responses output items 原地补齐 assistant message 的 phase 字段。
// 已带 phase 的不覆盖（尊重上游/原样透传）。从后往前扫一遍，复杂度 O(n)，不影响主链路。
export function applyAssistantMessagePhase(output: unknown): void {
  if (!Array.isArray(output)) return
  let toolCallSeen = false
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = output[index]
    if (isToolCallItem(item)) {
      toolCallSeen = true
      continue
    }
    if (!isAssistantMessageItem(item)) continue
    if (item.phase != null) continue
    item.phase = toolCallSeen ? "commentary" : "final_answer"
  }
}
