import "server-only"

import {
  prepareCodexOpenAICompatibleRequest,
  type CodexAdapter,
} from "./codex-protocol"
import {
  joinUrl,
  providerHeaders,
  type ProxyTarget,
} from "./common"
import { appendOutputLanguagePolicyToResponsesBody } from "./language-policy"

type AnyRecord = Record<string, any>

export interface OpenAICompatibleBuiltRequest {
  url: string
  init: RequestInit
  rewrittenBody: unknown
  adapter: CodexAdapter
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function joinOpenAICompatibleUrl(baseUrl: string, path: string) {
  const skipVersionPrefix = baseUrl.trim().endsWith("#")
  const normalizedBase = baseUrl.trim().replace(/#+$/, "").replace(/\/+$/, "")
  const normalizedPath = path.replace(/^\/+/, "")
  if (
    !skipVersionPrefix &&
    /(?:^|\/)(?:v\d+(?:beta)?|api\/v\d+)$/i.test(normalizedBase) &&
    normalizedPath.startsWith("v1/")
  ) {
    return joinUrl(normalizedBase, normalizedPath.slice(3))
  }
  return joinUrl(normalizedBase, normalizedPath)
}

function codexAdapterRequestsStream(adapter: CodexAdapter) {
  return adapter.type === "chat_completions"
    ? adapter.stream
    : adapter.requestIsStream
}

function isDashScopeQwenResponsesTarget(target: ProxyTarget) {
  if (target.provider.protocol !== "openai-responses") return false
  if (target.provider.rawResponsesPassthrough === true) return false
  const providerHint = `${target.provider.name} ${target.provider.baseUrl}`.toLowerCase()
  return (
    providerHint.includes("dashscope") ||
    providerHint.includes("aliyuncs") ||
    providerHint.includes("bailian") ||
    providerHint.includes("百炼") ||
    providerHint.includes("千问")
  )
}

function normalizeDashScopeQwenResponsesEffort(effort: unknown) {
  if (typeof effort !== "string") return undefined
  const normalized = effort.trim().toLowerCase()
  if (normalized === "off" || normalized === "disabled") return "none"
  if (normalized === "xhigh" || normalized === "max" || normalized === "ultra") return "high"
  if (["none", "minimal", "low", "medium", "high"].includes(normalized)) {
    return normalized
  }
  return undefined
}

function normalizeDashScopeQwenResponsesReasoning(
  body: unknown,
  target: ProxyTarget,
  upstreamPath: string,
) {
  if (!isDashScopeQwenResponsesTarget(target)) return
  if (upstreamPath.replace(/^\/+/, "").split("?")[0] !== "v1/responses") return
  if (!isObject(body)) return

  const existingReasoning = isObject(body.reasoning) ? body.reasoning : undefined
  const requestedEffort =
    target.reasoning === "off"
      ? "none"
      : existingReasoning?.effort ?? body.reasoning_effort
  const effort = normalizeDashScopeQwenResponsesEffort(requestedEffort)
  if (!effort) return

  body.reasoning = {
    ...(existingReasoning || {}),
    effort,
  }
  delete body.reasoning_effort
}

export function buildOpenAICompatibleRequest(
  target: ProxyTarget,
  path: string,
  body: unknown,
): OpenAICompatibleBuiltRequest {
  const prepared = prepareCodexOpenAICompatibleRequest(
    path,
    body,
    target.modelId,
    target.reasoning,
    {
      preserveRequestControls: target.paused,
      rawResponsesPassthrough: Boolean(target.provider.rawResponsesPassthrough),
    },
  )
  normalizeDashScopeQwenResponsesReasoning(prepared.body, target, prepared.upstreamPath)
  appendOutputLanguagePolicyToResponsesBody(prepared.body, target)

  return {
    url: joinOpenAICompatibleUrl(target.provider.baseUrl, prepared.upstreamPath),
    rewrittenBody: prepared.body,
    adapter: prepared.adapter,
    init: {
      method: "POST",
      headers: providerHeaders(target.provider, {
        accept: codexAdapterRequestsStream(prepared.adapter)
          ? "text/event-stream"
          : "application/json",
        "content-type": "application/json",
      }),
      body: JSON.stringify(prepared.body),
    },
  }
}
