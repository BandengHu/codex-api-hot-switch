import "server-only"

import { isChatModel } from "@/lib/model-capabilities"
import type { RoutingSnapshot } from "@/lib/types"
import type { ProxyTarget } from "./common"

type AnyRecord = Record<string, unknown>

const MAX_SCAN_NODES = 800
const MAX_SCAN_TEXT = 24000

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function collectText(value: unknown, state = { nodes: 0, text: "" }): string {
  if (state.nodes > MAX_SCAN_NODES || state.text.length > MAX_SCAN_TEXT) {
    return state.text
  }
  state.nodes += 1
  if (typeof value === "string") {
    state.text += `\n${value}`
    return state.text
  }
  if (!value || typeof value !== "object") return state.text
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, state)
    return state.text
  }
  for (const child of Object.values(value as AnyRecord)) collectText(child, state)
  return state.text
}

function isMemoryMaintenanceRequest(body: unknown) {
  const text = collectText(body)
  return (
    /\bMemory Writing Agent\b/i.test(text) ||
    /\bConsolidation\b/i.test(text) ||
    /Phase 2 \(Consolidation\)/i.test(text) ||
    /[\\/]?\.codex[\\/]memories/i.test(text)
  )
}

export function applyAuxiliaryRouting(
  snapshot: RoutingSnapshot,
  body: unknown,
  target: ProxyTarget,
): ProxyTarget {
  if (target.paused || !snapshot.settings.auxiliaryRoutingEnabled) return target
  if (!isMemoryMaintenanceRequest(body)) return target

  const provider = snapshot.providers.find(
    (item) => item.id === snapshot.settings.auxiliaryProviderId,
  )
  const model = snapshot.models.find(
    (item) => item.id === snapshot.settings.auxiliaryModelId,
  )
  if (!provider || !provider.enabled || !model || model.providerId !== provider.id) {
    return target
  }
  if (!isChatModel(model)) return target

  return {
    ...target,
    provider,
    model,
    modelId: model.modelId,
    reasoning: model.supportsReasoning ? snapshot.settings.auxiliaryReasoning : "off",
  }
}
