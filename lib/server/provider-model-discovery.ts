import "server-only"

import type { Provider } from "@/lib/types"
import {
  buildProviderModelsUrlCandidates,
  normalizeDiscoveredModels,
  type ProviderModelDiscoveryResult,
} from "@/lib/provider-model-discovery"

const MAX_MODEL_LIST_BYTES = 2 * 1024 * 1024

export async function discoverProviderModels(
  provider: Provider,
): Promise<ProviderModelDiscoveryResult> {
  const primary = provider.endpoints[0]
  if (!primary) throw new Error("供应商没有主用端点")
  if (!primary.enabled) throw new Error("主用端点已停用，不能获取模型")
  if (!primary.baseUrl.trim()) throw new Error("主用端点 URL 不能为空")
  if (!primary.apiKey.trim()) throw new Error("主用端点 API Key 不能为空")

  const urls = buildProviderModelsUrlCandidates(
    primary.baseUrl,
    provider.protocol,
    primary.apiKey,
  )
  const controller = new AbortController()
  const timeoutMs = Math.min(Math.max(provider.timeoutMs, 1000), 15000)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let lastRetryableError = ""
    for (const [index, url] of urls.entries()) {
      const response = await fetch(url, {
        method: "GET",
        headers: buildDiscoveryHeaders(provider, primary.apiKey),
        signal: controller.signal,
        cache: "no-store",
      })
      const contentLength = Number(response.headers.get("content-length") || 0)
      if (contentLength > MAX_MODEL_LIST_BYTES) {
        throw new Error("上游模型列表响应过大，已停止读取")
      }

      const text = await response.text()
      const safeText = redactSecrets(text, provider, primary.apiKey)
      const isHtml = /^\s*<!doctype html|^\s*<html[\s>]/iu.test(text)
      if (!response.ok) {
        if (index < urls.length - 1 && (response.status === 404 || isHtml)) {
          lastRetryableError = `HTTP ${response.status} ${response.statusText}`
          continue
        }
        const detail = isHtml
          ? "上游返回 HTML 页面，模型接口地址可能不正确"
          : safeText.trim().slice(0, 300)
        throw new Error(
          `获取模型失败：HTTP ${response.status} ${response.statusText}${detail ? `：${detail}` : ""}`,
        )
      }
      if (text.length > MAX_MODEL_LIST_BYTES) {
        throw new Error("上游模型列表响应过大，已停止解析")
      }

      let body: unknown
      try {
        body = JSON.parse(text) as unknown
      } catch {
        if (index < urls.length - 1 && isHtml) {
          lastRetryableError = "上游返回 HTML 页面"
          continue
        }
        throw new Error(
          isHtml
            ? "上游返回 HTML 页面，模型接口地址可能不正确"
            : `上游没有返回 JSON 模型列表：${safeText.trim().slice(0, 180)}`,
        )
      }

      return {
        endpointName: primary.name,
        models: normalizeDiscoveredModels(body),
        fetchedAt: new Date().toISOString(),
      }
    }
    throw new Error(`获取模型失败：${lastRetryableError || "没有可用的模型接口地址"}`)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`获取模型超时：超过 ${timeoutMs}ms 未响应`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timeout)
  }
}

function buildDiscoveryHeaders(provider: Provider, apiKey: string): Headers {
  const headers = new Headers({ accept: "application/json" })
  for (const entry of provider.headers) {
    const key = entry.key.trim()
    if (key) headers.set(key, entry.value)
  }
  if (provider.protocol === "anthropic") {
    if (!headers.has("x-api-key")) headers.set("x-api-key", apiKey.trim())
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
  } else if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${apiKey.trim()}`)
  }
  return headers
}

function redactSecrets(text: string, provider: Provider, apiKey: string) {
  const secrets = [
    apiKey,
    ...provider.headers.map((entry) => entry.value.trim()).filter(Boolean),
  ].filter((secret) => secret.length >= 4)
  return secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text)
}
