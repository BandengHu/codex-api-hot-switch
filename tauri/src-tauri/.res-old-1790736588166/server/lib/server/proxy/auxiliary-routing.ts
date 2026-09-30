import "server-only"

import { isChatModel } from "@/lib/model-capabilities"
import { resolvePrimaryProvider } from "@/lib/provider-endpoints"
import type { RoutingSnapshot } from "@/lib/types"
import { isMemoryMaintenanceRequest } from "./auxiliary-routing-classifier"
import type { ProxyTarget } from "./common"

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
    provider: resolvePrimaryProvider(provider),
    model,
    modelId: model.modelId,
    reasoning: model.supportsReasoning ? snapshot.settings.auxiliaryReasoning : "off",
  }
}
