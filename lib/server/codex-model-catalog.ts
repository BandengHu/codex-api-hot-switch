import "server-only"

import { isChatModel } from "@/lib/model-capabilities"
import type { Model, Provider, RoutingSnapshot } from "@/lib/types"
import { supportsRelayWebSearchProvider } from "./proxy/web-search-relay"

export const CODEX_AUTO_MODEL_SLUG = "switchgate__auto"
export const CODEX_AUTO_MODEL_DISPLAY_NAME = "自动"
const CODEX_ROUTED_MODEL_PREFIX = "switchgate__"
const CODEX_MODEL_OWNER = "codex_switchgate"

const REASONING_LEVELS = [
  { effort: "minimal", description: "极低推理" },
  { effort: "low", description: "低推理" },
  { effort: "medium", description: "中推理" },
  { effort: "high", description: "高推理" },
  { effort: "xhigh", description: "超高推理" },
]

function providersById(snapshot: RoutingSnapshot) {
  return new Map(snapshot.providers.map((provider) => [provider.id, provider]))
}

function routeIdPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "model"
}

export function codexRoutedModelSlug(model: Model) {
  return `${CODEX_ROUTED_MODEL_PREFIX}${routeIdPart(model.id)}`
}

function codexRoutedModelDisplayName(model: Model, provider: Provider) {
  return `${model.displayName} · ${provider.name}`
}

function isOpenAIOfficialProvider(provider: Provider | undefined) {
  if (!provider) return false
  if (provider.id === "openai-official") return true
  if (provider.name.toLowerCase().includes("openai 官方")) return true
  try {
    return new URL(provider.baseUrl).hostname.toLowerCase() === "api.openai.com"
  } catch {
    return false
  }
}

function supportsHostedWebSearch(provider: Provider | undefined) {
  return (
    provider?.protocol === "openai-responses" &&
    (provider.rawResponsesPassthrough === true || isOpenAIOfficialProvider(provider))
  )
}

function supportsCodexWebSearch(provider: Provider | undefined) {
  return supportsHostedWebSearch(provider) || supportsRelayWebSearchProvider(provider)
}

function enabledChatModels(snapshot: RoutingSnapshot) {
  const providers = providersById(snapshot)
  return snapshot.models
    .filter((model) => model.enabled && isChatModel(model))
    .map((model) => {
      const provider = providers.get(model.providerId)
      return provider?.enabled ? { model, provider } : null
    })
    .filter((entry): entry is { model: Model; provider: Provider } => Boolean(entry))
}

function catalogModel(
  slug: string,
  contextWindow: number,
  supportsReasoning: boolean,
  supportsVision: boolean,
  supportsSearch: boolean,
  priority: number,
) {
  return {
    slug,
    display_name: slug,
    description: slug,
    default_reasoning_level: supportsReasoning ? "medium" : "off",
    supported_reasoning_levels: supportsReasoning
      ? REASONING_LEVELS
      : [{ effort: "off", description: "关闭推理" }],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    base_instructions: "",
    supports_reasoning_summaries: supportsReasoning,
    default_reasoning_summary: "none",
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    ...(supportsSearch ? { web_search_tool_type: "text_and_image" } : {}),
    truncation_policy: {
      mode: "tokens",
      limit: 10000,
    },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: supportsVision,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: supportsVision ? ["text", "image"] : ["text"],
    supports_search_tool: supportsSearch,
    use_responses_lite: false,
  }
}

export function buildCodexClientModelsResponse(snapshot: RoutingSnapshot) {
  const providers = providersById(snapshot)
  const defaultProvider = providers.get(snapshot.settings.defaultProviderId)
  const models = [
    catalogModel(
      CODEX_AUTO_MODEL_SLUG,
      200000,
      true,
      true,
      supportsCodexWebSearch(defaultProvider),
      0,
    ),
  ]

  let priority = 1
  for (const { model, provider } of enabledChatModels(snapshot)) {
    const slug = codexRoutedModelSlug(model)
    models.push(
      catalogModel(
        slug,
        model.contextLength,
        model.supportsReasoning,
        model.supportsVision,
        supportsCodexWebSearch(provider),
        priority,
      ),
    )
    priority += 1
  }

  return { models }
}

export function buildOpenAIModelsResponse(snapshot: RoutingSnapshot) {
  const data: Array<Record<string, string | number>> = [
    {
      id: CODEX_AUTO_MODEL_SLUG,
      object: "model",
      created: 0,
      owned_by: CODEX_MODEL_OWNER,
      display_name: CODEX_AUTO_MODEL_SLUG,
    },
  ]

  for (const { model } of enabledChatModels(snapshot)) {
    const slug = codexRoutedModelSlug(model)
    data.push({
      id: slug,
      object: "model",
      created: 0,
      owned_by: CODEX_MODEL_OWNER,
      display_name: slug,
    })
  }

  return { object: "list", data }
}

export function buildCodexDesktopModelLabelsResponse(snapshot: RoutingSnapshot) {
  return {
    provider_name: "Codex SwitchGate",
    models: [
      {
        id: CODEX_AUTO_MODEL_SLUG,
        label: CODEX_AUTO_MODEL_DISPLAY_NAME,
        provider_name: "Codex SwitchGate",
        model_name: CODEX_AUTO_MODEL_DISPLAY_NAME,
        upstream_model: "",
      },
      ...enabledChatModels(snapshot).map(({ model, provider }) => ({
        id: codexRoutedModelSlug(model),
        label: codexRoutedModelDisplayName(model, provider),
        provider_name: provider.name,
        model_name: model.displayName,
        upstream_model: model.modelId,
      })),
    ],
  }
}

export function resolveCodexRoutedModel(
  snapshot: RoutingSnapshot,
  requestedModel: string,
) {
  const requested = requestedModel.trim()
  if (!requested || requested === CODEX_AUTO_MODEL_SLUG) return null

  for (const { model, provider } of enabledChatModels(snapshot)) {
    if (requested === codexRoutedModelSlug(model)) {
      return { provider, model }
    }
  }

  return null
}
