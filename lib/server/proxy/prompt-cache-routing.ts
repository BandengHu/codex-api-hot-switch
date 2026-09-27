import "server-only"

import type { ResolvedProvider } from "@/lib/types"

type AnyRecord = Record<string, unknown>

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function shouldSendChatPromptCacheKey(provider: ResolvedProvider) {
  const mode = provider.promptCacheRouting || "auto"
  if (mode === "enabled") return true
  if (mode === "disabled") return false

  try {
    const url = new URL(provider.baseUrl.replace(/#+$/, ""))
    const host = url.hostname.toLowerCase()
    if (host === "api.openai.com") return true
    if (host !== "api.kimi.com") return false
    const path = url.pathname.replace(/\/+$/, "")
    return path === "/coding" || path.startsWith("/coding/")
  } catch {
    return false
  }
}

export function injectChatPromptCacheKey(
  provider: ResolvedProvider,
  chatBody: AnyRecord,
  responsesBody: AnyRecord,
) {
  if (!shouldSendChatPromptCacheKey(provider)) return false
  const key = safeTrim(responsesBody.prompt_cache_key)
  if (!key) return false
  chatBody.prompt_cache_key = key
  return true
}
