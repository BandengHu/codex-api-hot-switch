import assert from "node:assert/strict"
import test from "node:test"
import {
  buildImportedModelDrafts,
  buildProviderModelsUrl,
  buildProviderModelsUrlCandidates,
  defaultSelectedDiscoveredModelIds,
  normalizeDiscoveredModels,
} from "@/lib/provider-model-discovery"

test("builds the models URL from common provider endpoint forms", () => {
  assert.equal(
    buildProviderModelsUrl(
      "https://api.example.com/v1/chat/completions",
      "openai-chat",
      "sk-test",
    ),
    "https://api.example.com/v1/models",
  )
  assert.deepEqual(
    buildProviderModelsUrlCandidates("https://code-plan.site/", "openai-responses", "sk-test"),
    ["https://code-plan.site/v1/models", "https://code-plan.site/models"],
  )
  assert.equal(
    buildProviderModelsUrl("https://generativelanguage.example.com/v1", "gemini", "key-1"),
    "https://generativelanguage.example.com/v1/models?key=key-1",
  )
})

test("normalizes OpenAI and Gemini model list shapes", () => {
  const models = normalizeDiscoveredModels({
    data: [
      {
        id: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        context_window: 353000,
        capabilities: ["tools", "vision"],
      },
      { id: "gpt-5.6-sol" },
    ],
  })

  assert.deepEqual(models, [{
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    contextLength: 353000,
    supportsVision: true,
    supportsTools: true,
  }])
})

test("accepts direct arrays and string model ids", () => {
  assert.deepEqual(normalizeDiscoveredModels([
    "qwen3-max",
    { name: "qwen3-plus", displayName: "Qwen3 Plus" },
  ]), [
    { id: "qwen3-max", displayName: "qwen3-max" },
    { id: "qwen3-plus", displayName: "Qwen3 Plus" },
  ])
})

test("imports only selected models and skips existing ids case-insensitively", () => {
  const imported = buildImportedModelDrafts(
    "provider-1",
    [
      { id: "gpt-5.6-sol", displayName: "GPT Sol" },
      { id: "QWEN3-MAX", displayName: "Qwen Max", supportsReasoning: true },
    ],
    ["gpt-5.6-sol", "qwen3-max"],
    [{
      id: "existing",
      providerId: "provider-1",
      displayName: "GPT Sol",
      modelId: "GPT-5.6-SOL",
      capabilities: ["chat"],
      contextLength: 128000,
      supportsReasoning: false,
      reasoningDialect: "inherit",
      supportsVision: false,
      enabled: true,
    }],
  )

  assert.equal(imported.length, 1)
  assert.equal(imported[0].modelId, "QWEN3-MAX")
  assert.deepEqual(imported[0].capabilities, ["chat", "reasoning"])
})

test("selects no models for a new provider and existing models for an edited provider", () => {
  const discovered = [
    { id: "model-a", displayName: "Model A" },
    { id: "model-b", displayName: "Model B" },
  ]

  assert.deepEqual(defaultSelectedDiscoveredModelIds(discovered, []), [])
  assert.deepEqual(
    defaultSelectedDiscoveredModelIds(discovered, ["MODEL-B"]),
    ["model-b"],
  )
})
