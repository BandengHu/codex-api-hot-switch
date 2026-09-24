import assert from "node:assert/strict"
import test from "node:test"

import type { Model, Provider } from "@/lib/types"
import {
  WORKBUDDY_CREDENTIAL_PLACEHOLDER,
  WORKBUDDY_MAX_CONTEXT_LENGTH,
  WORKBUDDY_PROVIDER_ID,
  WORKBUDDY_SEED_STATE_VERSION,
  clampWorkbuddyContextLength,
  isWorkbuddyProvider,
  seedWorkbuddyBuiltin,
  workbuddyCatalogModels,
  workbuddyCatalogUrl,
  workbuddyPresetModels,
  workbuddyProviderTemplate,
} from "./workbuddy-provider"

test("内置供应商固定指向 WorkBuddy 上游并按本机登录态鉴权", () => {
  const provider = workbuddyProviderTemplate()
  assert.equal(provider.id, WORKBUDDY_PROVIDER_ID)
  assert.equal(provider.protocol, "openai-chat")
  assert.equal(provider.endpoints[0].baseUrl, "https://www.codebuddy.cn/v2")
  assert.equal(provider.endpoints[0].apiKey, WORKBUDDY_CREDENTIAL_PLACEHOLDER)
  assert.equal(provider.reasoningDialect, "workbuddy-effort")
  assert.equal(
    provider.headers.find((header) => header.key === "X-IDE-Name")?.value,
    "CLI",
  )
})

test("凭据注入按供应商识别，克隆到官方域名上照样命中", () => {
  const template = workbuddyProviderTemplate()
  assert.equal(isWorkbuddyProvider(template), true)
  assert.equal(
    isWorkbuddyProvider({
      id: "cloned-provider",
      endpoints: [{ baseUrl: "https://copilot.tencent.com/v2/chat", apiKey: "" }],
    } as unknown as Provider),
    true,
  )
  assert.equal(
    isWorkbuddyProvider({
      id: "prov-openai",
      endpoints: [{ baseUrl: "https://api.openai.com/v1", apiKey: "" }],
    } as unknown as Provider),
    false,
  )
})

test("模型目录地址取站点根上的 /v3/config", () => {
  assert.equal(
    workbuddyCatalogUrl("https://www.codebuddy.cn/v2/chat"),
    "https://www.codebuddy.cn/v3/config",
  )
  assert.equal(
    workbuddyCatalogUrl("https://copilot.tencent.com/v2/chat/completions"),
    "https://copilot.tencent.com/v3/config",
  )
})

test("目录里只保留能走 chat 接口的模型，并把上下文压到账号实际可用容量", () => {
  const models = workbuddyCatalogModels({
    code: 0,
    data: {
      models: [
        {
          id: "hy4-preview",
          name: "Hy4 preview",
          maxInputTokens: 1_000_000,
          supportsImages: true,
          supportsReasoning: true,
          supportsToolCall: true,
        },
        {
          id: "hy3",
          name: "Hy3",
          maxInputTokens: 192_000,
          supportsToolCall: true,
        },
        { id: "hunyuan-image-alpha", name: "Hunyuan Image" },
        {
          id: "retired-model",
          name: "Retired",
          maxInputTokens: 1000,
          disabled: true,
        },
        { id: "hy4-preview", name: "Duplicated", maxInputTokens: 1000 },
      ],
    },
  })
  assert.deepEqual(models, [
    {
      id: "hy4-preview",
      displayName: "Hy4 preview",
      contextLength: WORKBUDDY_MAX_CONTEXT_LENGTH,
      supportsReasoning: true,
      supportsVision: true,
      supportsTools: true,
    },
    {
      id: "hy3",
      displayName: "Hy3",
      contextLength: 192_000,
      supportsReasoning: false,
      supportsVision: false,
      supportsTools: true,
    },
  ])
  assert.deepEqual(workbuddyCatalogModels({ data: {} }), [])
})

test("老数据里没有内置供应商时补一份模板和内置模型", () => {
  const other = { id: "prov-openai" } as Provider
  const seeded = seedWorkbuddyBuiltin([other], [], 2)

  assert.equal(seeded.providers.length, 2)
  assert.equal(seeded.providers[1].id, WORKBUDDY_PROVIDER_ID)
  assert.equal(seeded.providers[1].endpoints[0].baseUrl, "https://www.codebuddy.cn/v2")
  assert.equal(
    seeded.providers[1].endpoints[0].apiKey,
    WORKBUDDY_CREDENTIAL_PLACEHOLDER,
  )
  assert.equal(seeded.providers[1].reasoningDialect, "workbuddy-effort")
  assert.equal(seeded.models.length, workbuddyPresetModels().length)
})

test("用户删掉、改坏或停用内置供应商之后不再被强行改回来", () => {
  const tampered = workbuddyProviderTemplate()
  tampered.endpoints[0].baseUrl = "https://mirror.example/v1"
  tampered.enabled = false
  const seeded = seedWorkbuddyBuiltin([tampered], [], 2)

  // 供应商还在状态里（哪怕被改过），就原样保留，不按代码归位。
  assert.equal(seeded.providers.length, 1)
  assert.equal(seeded.providers[0].endpoints[0].baseUrl, "https://mirror.example/v1")
  assert.equal(seeded.providers[0].enabled, false)
})

test("内置模型删掉之后不再被强行塞回来", () => {
  const presets = workbuddyPresetModels()
  const kept = presets.slice(0, 3)
  const seeded = seedWorkbuddyBuiltin([workbuddyProviderTemplate()], kept, 2)

  assert.equal(seeded.models.length, 3)
  assert.deepEqual(
    seeded.models.map((model) => model.modelId),
    kept.map((model) => model.modelId),
  )
})

test("铺底版本之后，用户删光内置供应商和模型都不会复活", () => {
  const version = WORKBUDDY_SEED_STATE_VERSION
  const deleted = seedWorkbuddyBuiltin([{ id: "prov-openai" } as Provider], [], version)
  assert.equal(deleted.providers.some((p) => p.id === WORKBUDDY_PROVIDER_ID), false)
  assert.deepEqual(deleted.models, [])

  const emptied = seedWorkbuddyBuiltin([workbuddyProviderTemplate()], [], version)
  assert.deepEqual(emptied.models, [])
  assert.equal(emptied.providers.length, 1)
})

test("上下文上限只压不抬，铺底模型一律不超过 272K", () => {
  assert.equal(clampWorkbuddyContextLength(1_000_000), WORKBUDDY_MAX_CONTEXT_LENGTH)
  assert.equal(clampWorkbuddyContextLength(512_000), WORKBUDDY_MAX_CONTEXT_LENGTH)
  assert.equal(clampWorkbuddyContextLength(272_000), 272_000)
  assert.equal(clampWorkbuddyContextLength(192_000), 192_000)

  for (const model of workbuddyPresetModels()) {
    assert.ok(
      model.contextLength <= WORKBUDDY_MAX_CONTEXT_LENGTH,
      `${model.modelId} 的上下文 ${model.contextLength} 超过了上限`,
    )
  }
})
