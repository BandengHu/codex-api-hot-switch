import "server-only"

import type { DiscoveredModel, ProviderModelDiscoveryResult } from "@/lib/provider-model-discovery"
import {
  primaryProviderEndpoint,
  resolveProviderEndpoint,
} from "@/lib/provider-endpoints"
import type { HeaderEntry, Provider, ResolvedProvider } from "@/lib/types"
import {
  isWorkbuddyProvider,
  workbuddyCatalogUrl,
  workbuddyCatalogModels,
  workbuddySiteUrl,
} from "@/lib/workbuddy-provider"
import { getSystemProxyDispatcher } from "@/lib/server/proxy/system-proxy"
import type { WorkbuddyAccount } from "./account"
import { readActivePoolAccount } from "./pool-account"

const MAX_CATALOG_BYTES = 2 * 1024 * 1024
const CATALOG_TIMEOUT_MS = 15_000

/**
 * 把当前生效账号的登录态写进供应商：token 落到每个端点，账号相关的头补齐。
 *
 * 生效账号 = 号池里被手动选中的那个（默认本机桌面端登录态）。号池**不做自动轮转**，
 * 换号只发生在用户点「切换」时，所以这里每次请求现读一次，切完立刻生效。
 *
 * 非 WorkBuddy 供应商原样返回——这批头只有它认。
 */
export async function withWorkbuddyCredentials(provider: Provider): Promise<Provider> {
 if (!isWorkbuddyProvider(provider)) return provider
 const account = await readActivePoolAccount()
 return {
 ...provider,
 endpoints: provider.endpoints.map((endpoint) => ({
 ...endpoint,
 apiKey: account.accessToken,
 })),
 headers: withAccountHeaders(provider.headers, account, provider),
}
}

export async function withWorkbuddyTargetCredentials<T extends { provider: ResolvedProvider }>(
  target: T,
): Promise<T> {
  if (!isWorkbuddyProvider(target.provider)) return target
  const injected = await withWorkbuddyCredentials(target.provider)
  const endpoint =
    injected.endpoints.find(
      (candidate) => candidate.id === target.provider.activeEndpointId,
    ) ?? primaryProviderEndpoint(injected)
  return { ...target, provider: resolveProviderEndpoint(injected, endpoint) }
}

/** 账号维度的头：桌面端按登录态带，用户的静态头列表里没有。 */
function withAccountHeaders(
  headers: HeaderEntry[],
  account: WorkbuddyAccount,
  provider: Provider,
): HeaderEntry[] {
  const dynamic: HeaderEntry[] = []
  if (account.uid) {
    dynamic.push({ id: "workbuddy-account-user-id", key: "X-User-Id", value: account.uid })
  }
  if (account.domain) {
    dynamic.push({ id: "workbuddy-account-domain", key: "X-Domain", value: account.domain })
  }
  const site = workbuddySiteUrl(primaryProviderEndpoint(provider).baseUrl)
  dynamic.push(
    { id: "workbuddy-account-origin", key: "Origin", value: site },
    { id: "workbuddy-account-referer", key: "Referer", value: `${site}/` },
  )

  const keys = new Set(dynamic.map((entry) => entry.key.toLowerCase()))
  return [
    ...headers.filter((entry) => !keys.has(entry.key.trim().toLowerCase())),
    ...dynamic,
  ]
}

/**
 * 账号可用的模型目录。列表接口不在 chat 前缀下，是站点根上的 `/v3/config`，
 * 和桌面端配置接口同一份数据。
 */
export async function discoverWorkbuddyCatalogModels(
  provider: Provider,
): Promise<ProviderModelDiscoveryResult> {
  const endpoint =
    provider.endpoints.find((candidate) => candidate.enabled) ?? primaryProviderEndpoint(provider)
  const url = workbuddyCatalogUrl(endpoint.baseUrl)
  const headers = new Headers({ accept: "application/json" })
  for (const entry of provider.headers) {
    const key = entry.key.trim()
    if (key) headers.set(key, entry.value)
  }
  if (endpoint.apiKey.trim() && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${endpoint.apiKey.trim()}`)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
    const dispatcher = getSystemProxyDispatcher(url)
    const init: Record<string, unknown> = {
      method: "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
    }
    if (dispatcher) init.dispatcher = dispatcher
    const response = await fetch(url, init as RequestInit)
    const text = await response.text()
    if (text.length > MAX_CATALOG_BYTES) {
      throw new Error("WorkBuddy 模型目录响应过大，已停止解析")
    }
    if (!response.ok) {
      throw new Error(
        `获取模型失败：HTTP ${response.status} ${response.statusText}${text.trim() ? `：${text.trim().slice(0, 200)}` : ""}`,
      )
    }
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`WorkBuddy 没有返回 JSON 模型目录：${text.trim().slice(0, 180)}`)
    }
    return {
      endpointName: endpoint.name,
      models: workbuddyCatalogModels(payload),
      fetchedAt: new Date().toISOString(),
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`获取模型超时：超过 ${CATALOG_TIMEOUT_MS}ms 未响应`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timeout)
  }
}
