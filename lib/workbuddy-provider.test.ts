import assert from "node:assert/strict"
import test from "node:test"

import type { Model, Provider } from "@/lib/types"
import {
  WORKBUDDY_CREDENTIAL_PLACEHOLDER,
  WORKBUDDY_PROVIDER_ID,
  isWorkbuddyProvider,
  mergeWorkbuddyModels,
  mergeWorkbuddyProvider,
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

test("目录里只保留能走 chat 接口的模型", () => {
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
      contextLength: 1_000_000,
      supportsReasoning: true,
      supportsVision: true,
      supportsTools: true,
    },
  ])
  assert.deepEqual(workbuddyCatalogModels({ data: {} }), [])
})

test("内置供应商不随状态消失，结构字段以代码为准", () => {
  const other = { id: "prov-openai" } as Provider
  const added = mergeWorkbuddyProvider([other])
  assert.equal(added.length, 2)
  assert.equal(added[1].id, WORKBUDDY_PROVIDER_ID)

  const tampered = workbuddyProviderTemplate()
  tampered.endpoints[0].baseUrl = "https://evil.example/v1"
  tampered.endpoints[0].apiKey = "sk-user-typed"
  tampered.enabled = false
  tampered.reasoningDialect = "none"
  const merged = mergeWorkbuddyProvider([other, tampered])
  assert.equal(merged[1].id, WORKBUDDY_PROVIDER_ID)
  assert.equal(merged[1].endpoints[0].baseUrl, "https://www.codebuddy.cn/v2")
  assert.equal(merged[1].endpoints[0].apiKey, WORKBUDDY_CREDENTIAL_PLACEHOLDER)
  assert.equal(merged[1].reasoningDialect, "workbuddy-effort")
  assert.equal(merged[1].enabled, false)
})

test("内置模型名单由代码说了算，用户开关和额外模型保留", () => {
  const presets = workbuddyPresetModels()
  const first = presets[0]
  const disabled: Model = { ...first, id: "m-user-renamed", enabled: false }
  const extra: Model = {
    ...first,
    id: "m-discovered-1",
    displayName: "GLM 4.7",
    modelId: "glm-4.7",
    contextLength: 200_000,
  }
  const merged = mergeWorkbuddyModels([disabled, extra])

  assert.equal(merged.length, presets.length + 1)
  const restored = merged.find((model) => model.modelId === first.modelId)
  assert.equal(restored?.id, "m-user-renamed")
  assert.equal(restored?.enabled, false)
  assert.equal(restored?.reasoningDialect, "workbuddy-effort")
  assert.ok(merged.some((model) => model.modelId === "glm-4.7"))
})
