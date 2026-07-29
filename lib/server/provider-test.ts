import "server-only"

import {
  enabledProviderEndpoints,
  resolveProviderEndpoint,
} from "@/lib/provider-endpoints"
import type {
  Provider,
  ProviderTestResult,
  ResolvedProvider,
} from "@/lib/types"

function withTimeout(ms: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ms)
  return {
    signal: controller.signal,
    done: () => clearTimeout(timeout),
  }
}

function authHeaders(provider: ResolvedProvider): HeadersInit {
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

function testUrl(provider: ResolvedProvider) {
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

  const started = Date.now()
  const endpoints = enabledProviderEndpoints(provider)
  if (endpoints.length === 0) {
    return { ok: false, message: "供应商没有启用的 URL/API Key 组", provider }
  }

  const errors: string[] = []
  for (const endpoint of endpoints) {
    const resolved = resolveProviderEndpoint(provider, endpoint)
    const timer = withTimeout(Math.min(provider.timeoutMs, 15000))
    try {
      const response = await fetch(testUrl(resolved), {
        method: "GET",
        headers: authHeaders(resolved),
        signal: timer.signal,
        cache: "no-store",
      })
      if (!response.ok) {
        const text = await response.text()
        const detail = text ? `：${text.slice(0, 240)}` : ""
        errors.push(`${endpoint.name}：HTTP ${response.status} ${response.statusText}${detail}`)
        continue
      }
      return {
        ok: true,
        message: `${endpoint.name}健康检查通过，耗时 ${Date.now() - started}ms`,
        provider: { ...provider, health: "healthy", healthMessage: undefined },
      }
    } catch (error) {
      errors.push(
        error instanceof Error && error.name === "AbortError"
          ? `${endpoint.name}：健康检查超时`
          : `${endpoint.name}：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      timer.done()
    }
  }

  const message = `全部端点健康检查失败：${errors.join("；")}`
  return {
    ok: false,
    message,
    provider: { ...provider, health: "down", healthMessage: message },
  }
}
