import type { Model, ProtocolType } from "@/lib/types"

export interface DiscoveredModel {
  id: string
  displayName: string
  ownedBy?: string
  contextLength?: number
  supportsReasoning?: boolean
  supportsVision?: boolean
  supportsTools?: boolean
}

export interface ProviderModelDiscoveryResult {
  endpointName: string
  models: DiscoveredModel[]
  fetchedAt: string
}

export function buildProviderModelsUrl(
  baseUrl: string,
  protocol: ProtocolType,
  apiKey: string,
) {
  return buildProviderModelsUrlCandidates(baseUrl, protocol, apiKey)[0]
}

export function buildProviderModelsUrlCandidates(
  baseUrl: string,
  protocol: ProtocolType,
  apiKey: string,
) {
  const base = baseUrl.trim().replace(/#+$/, "").replace(/\/+$/, "")
  if (!base) throw new Error("主用端点 URL 不能为空")

  const hasApiPath = /\/(v\d+(?:beta)?|api\/[^/]+|models|chat\/completions|responses)$/iu.test(base)
  const modelBases = /\/models$/iu.test(base)
    ? [base]
    : /\/(chat\/completions|responses)$/iu.test(base)
      ? [`${base.replace(/\/(chat\/completions|responses)$/iu, "")}/models`]
      : hasApiPath
        ? [`${base}/models`]
        : protocol === "gemini"
          ? [`${base}/models`]
          : [`${base}/v1/models`, `${base}/models`]

  return modelBases.map((modelBase) => {
    if (protocol !== "gemini" || !apiKey.trim()) return modelBase
    const url = new URL(modelBase)
    url.searchParams.set("key", apiKey.trim())
    return url.toString()
  })
}

export function normalizeDiscoveredModels(payload: unknown): DiscoveredModel[] {
  const items = extractModelItems(payload)
  const seen = new Set<string>()
  const models: DiscoveredModel[] = []

  for (const item of items) {
    const model = normalizeDiscoveredModel(item)
    if (!model) continue
    const key = model.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    models.push(model)
  }

  return models
}

export function buildImportedModelDrafts(
  providerId: string,
  discoveredModels: DiscoveredModel[],
  selectedIds: string[],
  knownModels: Model[],
): Model[] {
  const selected = new Set(selectedIds.map(normalizeModelId))
  const known = new Set(knownModels.map((model) => normalizeModelId(model.modelId)))
  const imported: Model[] = []

  for (const model of discoveredModels) {
    const normalizedId = normalizeModelId(model.id)
    if (!selected.has(normalizedId) || known.has(normalizedId)) continue
    known.add(normalizedId)
    const capabilities = ["chat"]
    if (model.supportsTools === true) capabilities.push("tools")
    if (model.supportsReasoning === true) capabilities.push("reasoning")
    if (model.supportsVision === true) capabilities.push("vision")
    imported.push({
      id: `m-discovered-${crypto.randomUUID().slice(0, 12)}`,
      providerId,
      displayName: model.displayName,
      modelId: model.id,
      capabilities,
      contextLength: model.contextLength ?? 128000,
      supportsReasoning: model.supportsReasoning === true,
      reasoningDialect: "inherit",
      supportsVision: model.supportsVision === true,
      enabled: true,
    })
  }

  return imported
}

export function defaultSelectedDiscoveredModelIds(
  discoveredModels: DiscoveredModel[],
  existingModelIds: string[],
) {
  const existing = new Set(existingModelIds.map(normalizeModelId))
  return discoveredModels
    .filter((model) => existing.has(normalizeModelId(model.id)))
    .map((model) => model.id)
}

export function normalizeModelId(value: string) {
  return value.trim().replace(/^models\//i, "").trim().toLowerCase()
}

function extractModelItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.models)) return payload.models
  return []
}

function normalizeDiscoveredModel(value: unknown): DiscoveredModel | null {
  if (typeof value === "string") {
    const id = value.trim()
    return id ? { id, displayName: id } : null
  }
  if (!isRecord(value)) return null

  const id = firstString(value.id, value.model, value.name)
  if (!id) return null
  const capabilities = readCapabilities(value)
  const modalities = readStrings(
    value.modalities,
    value.input_modalities,
    value.inputModalities,
  )

  const supportsReasoning =
    readBoolean(
      value.supports_reasoning,
      value.supportsReasoning,
      value.reasoning,
      value.thinking,
    ) ?? (capabilities.includes("reasoning") ? true : undefined)
  const supportsVision =
    readBoolean(value.supports_vision, value.supportsVision, value.vision) ??
    (capabilities.includes("vision") ||
    modalities.some((item) => /image|vision/i.test(item))
      ? true
      : undefined)
  const supportsTools =
    readBoolean(value.supports_tools, value.supportsTools, value.tools) ??
    (capabilities.includes("tools") ? true : undefined)
  const ownedBy = firstString(value.owned_by, value.ownedBy, value.owner)
  const contextLength = readPositiveNumber(
    value.context_length,
    value.contextLength,
    value.context_window,
    value.contextWindow,
    value.max_context_length,
    value.max_context_tokens,
    value.input_token_limit,
    value.inputTokenLimit,
  )

  return {
    id,
    displayName: firstString(value.display_name, value.displayName, value.name, value.id) || id,
    ...(ownedBy ? { ownedBy } : {}),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(supportsReasoning === undefined ? {} : { supportsReasoning }),
    ...(supportsVision === undefined ? {} : { supportsVision }),
    ...(supportsTools === undefined ? {} : { supportsTools }),
  }
}

function readCapabilities(value: Record<string, unknown>): string[] {
  const raw = value.capabilities ?? value.supported_capabilities ?? value.supportedCapabilities
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
  }
  if (isRecord(raw)) {
    return Object.entries(raw)
      .filter(([, enabled]) => enabled === true)
      .map(([name]) => name.toLowerCase())
  }
  return []
}

function readStrings(...values: unknown[]): string[] {
  return values.flatMap((value) => {
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string")
    }
    return typeof value === "string" ? [value] : []
  })
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() || ""
}

function readPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
    if (Number.isFinite(number) && number > 0) return Math.round(number)
  }
  return undefined
}

function readBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value
    if (value === "true") return true
    if (value === "false") return false
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
