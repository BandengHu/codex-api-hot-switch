import "server-only"

import type { Provider, ProviderTestResult } from "@/lib/types"

function withTimeout(ms: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ms)
  return {
    signal: controller.signal,
    done: () => clearTimeout(timeout),
  }
}

function authHeaders(provider: Provider): HeadersInit {
  const headers: Record<string, string> = {}
  for (const entry of provider.headers) {
    if (entry.key.trim()) headers[entry.key.trim()] = entry.value
  }
  if (provider.apiKey.trim()) {
    if (provider.protocol === "anthropic") {
      headers["x-api-key"] = provider.apiKey.trim()
      headers["anthropic-version"] ??= "2023-06-01"
    } else {
      headers.authorization = `Bearer ${provider.apiKey.trim()}`
    }
  }
  return headers
}

function joinUrl(baseUrl: string, path: string) {
  const base = baseUrl.trim().replace(/#+$/, "").replace(/\/+$/, "")
  return `${base}/${path.replace(/^\/+/, "")}`
}

function modelsUrl(baseUrl: string) {
  const base = baseUrl.trim().replace(/#+$/, "").replace(/\/+$/, "")
  if (base.toLowerCase().endsWith("/models")) return base
  if (base.toLowerCase().endsWith("/chat/completions")) {
    return `${base.slice(0, -"/chat/completions".length)}/models`
  }
  return joinUrl(base, "models")
}

function testUrl(provider: Provider) {
  if (provider.protocol === "gemini") {
    const url = new URL(joinUrl(provider.baseUrl, "models"))
    if (provider.apiKey.trim()) url.searchParams.set("key", provider.apiKey.trim())
    return url.toString()
  }
  return modelsUrl(provider.baseUrl)
}

export async function runProviderTest(
  provider: Provider,
): Promise<ProviderTestResult> {
  if (!provider.enabled) {
    return { ok: false, message: "供应商已停用，未发起健康检查", provider }
  }

  const timer = withTimeout(Math.min(provider.timeoutMs, 15000))
  const started = Date.now()
  try {
    const response = await fetch(testUrl(provider), {
      method: "GET",
      headers: authHeaders(provider),
      signal: timer.signal,
      cache: "no-store",
    })
    const duration = Date.now() - started
    if (!response.ok) {
      const text = await response.text()
      const detail = text ? `：${text.slice(0, 240)}` : ""
      return {
        ok: false,
        message: `上游健康检查失败：HTTP ${response.status} ${response.statusText}${detail}`,
        provider: {
          ...provider,
          health: response.status >= 500 ? "down" : "degraded",
          healthMessage: `HTTP ${response.status} ${response.statusText}`,
        },
      }
    }
    return {
      ok: true,
      message: `健康检查通过，耗时 ${duration}ms`,
      provider: { ...provider, health: "healthy", healthMessage: undefined },
    }
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `健康检查超时：超过 ${Math.min(provider.timeoutMs, 15000)}ms 未响应`
        : `健康检查失败：${error instanceof Error ? error.message : String(error)}`
    return {
      ok: false,
      message,
      provider: { ...provider, health: "down", healthMessage: message },
    }
  } finally {
    timer.done()
  }
}
