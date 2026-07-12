import assert from "node:assert/strict"
import test from "node:test"
import {
  cloneFormCopy,
  cloneProviderWithModels,
  dismissProviderSheetState,
  openCloneSheetState,
} from "./provider-clone"

const source = {
  id: "prov-source",
  name: "Code-Plan-Codex",
  protocol: "openai-responses" as const,
  baseUrl: "https://example.test/v1",
  apiKey: "secret",
  headers: [
    { id: "header-source", key: "X-Test", value: "1" },
    { id: "header-authorization", key: "Authorization", value: "Bearer secret" },
  ],
  bodyOverride: "",
  timeoutMs: 60000,
  reasoningDialect: "openai-reasoning-effort" as const,
  rawResponsesPassthrough: true,
  enabled: true,
  isDefault: true,
  health: "down" as const,
  healthMessage: "unavailable",
}

const models = [
  {
    id: "model-source",
    providerId: source.id,
    displayName: "GPT Test",
    modelId: "gpt-test",
    capabilities: ["chat", "tools"],
    contextLength: 123,
    supportsReasoning: true,
    reasoningDialect: "inherit" as const,
    supportsVision: false,
    enabled: true,
  },
]

test("clones provider and models without credentials or shared identifiers", () => {
  let next = 0
  const draft = cloneProviderWithModels(source, models, () => `new-${++next}`)

  assert.deepEqual(draft.provider, {
    ...source,
    id: "new-1",
    name: "Code-Plan-Codex（副本）",
    apiKey: "",
    headers: [
      { id: "new-2", key: "X-Test", value: "" },
      { id: "new-3", key: "Authorization", value: "" },
    ],
    isDefault: false,
    health: "healthy",
    healthMessage: undefined,
  })
  assert.equal(draft.models[0]?.id, "new-4")
  assert.equal(draft.models[0]?.providerId, "new-1")
  assert.deepEqual(draft.models[0]?.capabilities, ["chat", "tools"])
  assert.notEqual(draft.models[0]?.capabilities, models[0]?.capabilities)
})

test("openCloneSheetState pre-fills clone form session for the copy action", () => {
  let next = 0
  const session = openCloneSheetState(source, models, () => `new-${++next}`)

  assert.equal(session.sheetOpen, true)
  assert.equal(session.editing, null)
  assert.equal(session.cloneDraft.provider.name, "Code-Plan-Codex（副本）")
  assert.equal(session.cloneDraft.provider.apiKey, "")
  assert.equal(session.cloneDraft.models.length, 1)
  assert.equal(session.cloneDraft.models[0]?.modelId, "gpt-test")
  assert.equal(session.cloneDraft.models[0]?.providerId, session.cloneDraft.provider.id)

  const copy = cloneFormCopy(session.cloneDraft.models.length)
  assert.equal(copy.title, "复制供应商")
  assert.equal(copy.submitLabel, "创建副本")
  assert.equal(copy.successToast, "供应商副本已创建")
  assert.match(copy.description, /将同时复制 1 个关联模型/)
})

test("dismissProviderSheetState clears clone draft when sheet closes", () => {
  assert.deepEqual(dismissProviderSheetState(), {
    editing: null,
    cloneDraft: null,
    sheetOpen: false,
  })
})
