import "server-only"

import type { TokenUsage } from "@/lib/types"
import {
  isOpenAIChatProtocol,
  isOpenAIResponsesProtocol,
  type ProxyTarget,
} from "./common"
import {
  buildOpenAICompatibleRequest,
  type OpenAICompatibleBuiltRequest,
} from "./openai-compatible"
import {
  buildChatCompatibleRequest,
  type ChatCompatibleAdapter,
  type ChatCompatibleBuiltRequest,
} from "./chat-compatible"
import type { NativeAdapter } from "./native-canonical"
import { buildAnthropicRequest } from "./anthropic"
import { buildGeminiRequest } from "./gemini"
import { applyProviderBodyOverride } from "./request-overrides"
import { readDecodedResponseText } from "./content-encoding"

export interface BuiltProxyRequest {
  url: string
  init: RequestInit
  rewrittenBody: unknown
  adapter?:
    | OpenAICompatibleBuiltRequest["adapter"]
    | NativeAdapter
    | ChatCompatibleAdapter
}

export async function fetchWithProviderTimeout(
  target: ProxyTarget,
  built: Pick<BuiltProxyRequest, "url" | "init">,
  requestSignal?: AbortSignal,
) {
  const timeoutMs = Math.max(1000, target.provider.timeoutMs || 60000)
  const controller = new AbortController()
  const abortState: { cause: "timeout" | "client" | "" } = { cause: "" }
  const abort = (cause: "timeout" | "client") => {
    if (controller.signal.aborted) return
    abortState.cause = cause
    controller.abort()
  }
  const onClientAbort = () => abort("client")
  if (requestSignal?.aborted) {
    abort("client")
  } else {
    requestSignal?.addEventListener("abort", onClientAbort, { once: true })
  }
  const timer = setTimeout(() => abort("timeout"), timeoutMs)
  try {
    return await fetch(built.url, { ...built.init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted && abortState.cause === "client") {
      throw new Error("客户端已取消请求，上游请求已中止")
    }
    if (controller.signal.aborted && abortState.cause === "timeout") {
      throw new Error(`上游请求超时：超过 ${timeoutMs}ms 未响应`)
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("上游连接被中止")
    }
    throw error
  } finally {
    clearTimeout(timer)
    requestSignal?.removeEventListener("abort", onClientAbort)
  }
}

export function buildProxyRequest(
  target: ProxyTarget,
  path: string,
  body: unknown,
): BuiltProxyRequest {
  const built = (() => {
    if (isOpenAIResponsesProtocol(target.provider.protocol)) {
      return buildOpenAICompatibleRequest(target, path, body)
    }
    if (isOpenAIChatProtocol(target.provider.protocol)) {
      return buildChatCompatibleRequest(target, path, body) as ChatCompatibleBuiltRequest
    }
    if (target.provider.protocol === "anthropic") {
      return buildAnthropicRequest(target, path, body)
    }
    if (target.provider.protocol === "gemini") {
      return buildGeminiRequest(target, path, body)
    }
    throw new Error(`不支持的协议：${target.provider.protocol}`)
  })()

  const override = applyProviderBodyOverride(
    built.rewrittenBody,
    target.provider.bodyOverride,
  )
  if (!override.changed) return built

  return {
    ...built,
    rewrittenBody: override.body,
    init: {
      ...built.init,
      body: JSON.stringify(override.body),
    },
  }
}

export async function parseJsonSafe(response: Response) {
  const text = await readDecodedResponseText(response)
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export function extractTextSummary(value: unknown): string {
  const visited = new Set<unknown>()
  const texts: string[] = []

  const visit = (item: unknown, keyHint = "") => {
    if (texts.join("").length >= 800) return
    if (typeof item === "string") {
      if (
        keyHint === "text" ||
        keyHint === "content" ||
        keyHint === "output_text" ||
        keyHint === "message"
      ) {
        texts.push(item)
      }
      return
    }
    if (!item || typeof item !== "object" || visited.has(item)) return
    visited.add(item)
    if (Array.isArray(item)) {
      for (const child of item) visit(child, keyHint)
      return
    }
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      visit(child, key)
    }
  }

  visit(value)
  return texts.join("").replace(/\s+/g, " ").trim().slice(0, 800)
}

export function extractUsageSummary(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const usage = record.usage
  if (!usage || typeof usage !== "object") return undefined
  const usageRecord = usage as Record<string, unknown>
  const inputTokens = Number(
    usageRecord.input_tokens ??
      usageRecord.prompt_tokens ??
      usageRecord.promptTokenCount ??
      0,
  )
  const outputTokens = Number(
    usageRecord.output_tokens ??
      usageRecord.completion_tokens ??
      usageRecord.candidatesTokenCount ??
      0,
  )
  const totalTokens = Number(
    usageRecord.total_tokens ??
      usageRecord.totalTokenCount ??
      (Number.isFinite(inputTokens) ? inputTokens : 0) +
        (Number.isFinite(outputTokens) ? outputTokens : 0),
  )
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
  }
}
