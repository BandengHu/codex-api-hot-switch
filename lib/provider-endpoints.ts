import type {
  Provider,
  ProviderEndpoint,
  ResolvedProvider,
} from "@/lib/types"

export function createProviderEndpoint(
  providerId: string,
  patch: Partial<ProviderEndpoint> = {},
): ProviderEndpoint {
  return {
    id: patch.id || `${providerId}-endpoint-${crypto.randomUUID().slice(0, 8)}`,
    name: patch.name || "备用",
    baseUrl: patch.baseUrl || "",
    apiKey: patch.apiKey || "",
    enabled: patch.enabled !== false,
  }
}

export function primaryProviderEndpoint(provider: Provider): ProviderEndpoint {
  const endpoint = provider.endpoints[0]
  if (!endpoint) {
    throw new Error(`供应商「${provider.name}」没有配置主用 URL/API Key`)
  }
  return endpoint
}

export function effectiveEndpointBaseUrl(
  provider: Provider,
  endpoint: ProviderEndpoint,
) {
  const value = endpoint.baseUrl.trim() || primaryProviderEndpoint(provider).baseUrl.trim()
  if (!value) {
    throw new Error(`供应商「${provider.name}」的端点「${endpoint.name}」没有可用 URL`)
  }
  return value
}

export function resolveProviderEndpoint(
  provider: Provider,
  endpoint: ProviderEndpoint,
): ResolvedProvider {
  return {
    ...provider,
    baseUrl: effectiveEndpointBaseUrl(provider, endpoint),
    apiKey: endpoint.apiKey.trim(),
    activeEndpointId: endpoint.id,
    activeEndpointName: endpoint.name,
  }
}

export function resolvePrimaryProvider(provider: Provider): ResolvedProvider {
  return resolveProviderEndpoint(provider, primaryProviderEndpoint(provider))
}

export function enabledProviderEndpoints(provider: Provider) {
  return provider.endpoints.filter((endpoint) => endpoint.enabled)
}
