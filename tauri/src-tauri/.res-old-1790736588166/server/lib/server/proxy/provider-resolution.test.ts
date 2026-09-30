import assert from "node:assert/strict"
import test from "node:test"

import type { Model, Provider, RoutingSnapshot } from "@/lib/types"
import { applyAuxiliaryRouting } from "./auxiliary-routing"
import { resolveTarget } from "./common"
import { buildProxyRequest } from "./request-builder"

function provider(id: string, baseUrl: string): Provider {
  return {
    id,
    name: id,
    protocol: "openai-responses",
    endpoints: [
      {
        id: `${id}-primary`,
        name: "主用",
        baseUrl,
        apiKey: `${id}-key`,
        enabled: true,
      },
    ],
    headers: [],
    bodyOverride: "",
    timeoutMs: 90_000,
    reasoningDialect: "openai-reasoning-effort",
    rawResponsesPassthrough: true,
    enabled: true,
    isDefault: false,
    health: "healthy",
  }
}

function model(id: string, providerId: string, modelId: string): Model {
  return {
    id,
    providerId,
    displayName: modelId,
    modelId,
    capabilities: ["chat", "reasoning", "tools"],
    contextLength: 272_000,
    supportsReasoning: true,
    reasoningDialect: "inherit",
    supportsVision: false,
    enabled: true,
  }
}

function snapshot(): RoutingSnapshot {
  const primaryProvider = provider("provider-main", "https://main.example/v1")
  const auxiliaryProvider = provider("provider-aux", "https://aux.example/v1")
  const primaryModel = model("model-main", primaryProvider.id, "main-model")
  const auxiliaryModel = model("model-aux", auxiliaryProvider.id, "aux-model")
  return {
    providers: [primaryProvider, auxiliaryProvider],
    models: [primaryModel, auxiliaryModel],
    mappings: [],
    runtime: {
      takeover: "active",
      activeProviderId: primaryProvider.id,
      activeModelId: primaryModel.id,
      reasoning: "high",
    },
    settings: {
      auxiliaryRoutingEnabled: true,
      auxiliaryProviderId: auxiliaryProvider.id,
      auxiliaryModelId: auxiliaryModel.id,
      auxiliaryReasoning: "low",
    },
  } as unknown as RoutingSnapshot
}

test("active target resolves its primary endpoint before request construction", () => {
  const target = resolveTarget(snapshot(), {
    model: "client-model",
    input: "hello",
  })

  assert.equal(target.provider.baseUrl, "https://main.example/v1")
  assert.equal(target.provider.activeEndpointId, "provider-main-primary")
  const built = buildProxyRequest(target, "v1/responses", {
    model: "client-model",
    input: "hello",
  })
  assert.equal(built.url, "https://main.example/v1/responses")
})

test("auxiliary routing also resolves the selected provider endpoint", () => {
  const routing = snapshot()
  const initial = resolveTarget(routing, {
    model: "client-model",
    input: "hello",
  })
  const target = applyAuxiliaryRouting(
    routing,
    {
      model: "client-model",
      input: "Memory Writing Agent",
    },
    initial,
  )

  assert.equal(target.provider.baseUrl, "https://aux.example/v1")
  assert.equal(target.provider.activeEndpointId, "provider-aux-primary")
  const built = buildProxyRequest(target, "v1/responses", {
    model: "client-model",
    input: "Memory Writing Agent",
  })
  assert.equal(built.url, "https://aux.example/v1/responses")
})
