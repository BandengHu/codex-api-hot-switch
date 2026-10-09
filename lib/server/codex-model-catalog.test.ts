import assert from "node:assert/strict"
import test from "node:test"

import type { Model, Provider, RoutingSnapshot, WebSearchMode } from "@/lib/types"
import { buildCodexClientModelsResponse } from "./codex-model-catalog"

type CatalogModel = {
  slug: string
  supports_search_tool: boolean
  web_search_tool_type?: string
}

function testProvider(protocol: Provider["protocol"], rawResponsesPassthrough: boolean): Provider {
  return {
    id: "prov-test",
    name: "测试上游",
    protocol,
    endpoints: [
      {
        id: "prov-test-primary",
        name: "主用",
        baseUrl: "https://upstream.test/v1",
        apiKey: "test-key",
        enabled: true,
      },
    ],
    headers: [],
    bodyOverride: "",
    timeoutMs: 60000,
    reasoningDialect: "openai-reasoning-effort",
    rawResponsesPassthrough,
    enabled: true,
    isDefault: true,
    health: "healthy",
  }
}

function testModel(providerId: string): Model {
  return {
    id: "m-test",
    providerId,
    displayName: "测试模型",
    modelId: "test-model",
    capabilities: ["chat"],
    contextLength: 128000,
    supportsReasoning: true,
    reasoningDialect: "inherit",
    supportsVision: false,
    enabled: true,
  }
}

function testSnapshot(webSearchMode: WebSearchMode, provider: Provider): RoutingSnapshot {
  return {
    providers: [provider],
    models: [testModel(provider.id)],
    mappings: [],
    runtime: {
      takeover: "active",
      activeProviderId: provider.id,
      activeModelId: "m-test",
      reasoning: "medium",
    },
    settings: {
      listenAddress: "127.0.0.1",
      port: 8787,
      takeoverEnabled: true,
      defaultProviderId: provider.id,
      defaultModelId: "m-test",
      defaultReasoning: "medium",
      auxiliaryRoutingEnabled: false,
      auxiliaryProviderId: provider.id,
      auxiliaryModelId: "m-test",
      auxiliaryReasoning: "medium",
      codexSubagentModelSlugs: [],
      imageGenerationProviderId: provider.id,
      imageGenerationModelId: "m-test",
      logRetentionDays: 14,
      fullRequestLoggingEnabled: false,
      webSearchMode,
      alphaSearchMode: "auto",
      keyStorage: "",
      tokenStatsResetAt: "1970-01-01T00:00:00.000Z",
    },
  }
}

function catalogModels(webSearchMode: WebSearchMode, provider: Provider) {
  return buildCodexClientModelsResponse(testSnapshot(webSearchMode, provider))
    .models as CatalogModel[]
}

test("mcp / disabled 模式不声明托管 web_search（含 relay 与透传供应商）", () => {
  for (const mode of ["mcp", "disabled"] as const) {
    for (const provider of [
      testProvider("openai-responses", true),
      testProvider("openai-chat", false),
    ]) {
      for (const model of catalogModels(mode, provider)) {
        assert.equal(
          model.web_search_tool_type,
          undefined,
          `${mode}:${provider.protocol}:${model.slug}`,
        )
        assert.equal(
          model.supports_search_tool,
          false,
          `${mode}:${provider.protocol}:${model.slug}`,
        )
      }
    }
  }
})

test("builtin 模式为原样透传供应商保留托管 web_search", () => {
  const models = catalogModels("builtin", testProvider("openai-responses", true))
  assert.ok(models.length > 0)
  for (const model of models) {
    assert.equal(model.web_search_tool_type, "text_and_image")
    assert.equal(model.supports_search_tool, true)
  }
})

test("builtin 模式为内置 relay 供应商声明 web_search", () => {
  const models = catalogModels("builtin", testProvider("openai-chat", false))
  assert.ok(models.length > 0)
  for (const model of models) {
    assert.equal(model.web_search_tool_type, "text_and_image")
    assert.equal(model.supports_search_tool, true)
  }
})
