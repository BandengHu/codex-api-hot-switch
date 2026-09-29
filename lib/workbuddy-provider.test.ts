import assert from "node:assert/strict"
import test from "node:test"

import type { Model, Provider } from "@/lib/types"
import {
  WORKBUDDY_CREDENTIAL_PLACEHOLDER,
  WORKBUDDY_GLOBAL_API_BASE_URL,
  WORKBUDDY_GLOBAL_CREDENTIAL_PLACEHOLDER,
  WORKBUDDY_GLOBAL_PROVIDER_ID,
  WORKBUDDY_MAX_CONTEXT_LENGTH,
  WORKBUDDY_PROVIDER_ID,
  WORKBUDDY_SEED_STATE_VERSION,
  clampWorkbuddyContextLength,
  isWorkbuddyProvider,
  seedWorkbuddyBuiltin,
  workbuddyCatalogError,
  workbuddyCatalogModels,
  workbuddyCatalogUrl,
  workbuddyGlobalProviderTemplate,
  workbuddyPresetModelSpecs,
  workbuddyPresetModels,
  workbuddyProviderTemplate,
  workbuddyRealmOf,
  workbuddyRealmOfProvider,
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

test("按 baseUrl 判定 realm：国际站域走 global，其余回落国内", () => {
  assert.equal(workbuddyRealmOf("https://www.workbuddy.ai/v2"), "global")
  assert.equal(workbuddyRealmOf("https://workbuddy.ai/v2"), "global")
  assert.equal(workbuddyRealmOf("https://www.codebuddy.cn/v2"), "cn")
  assert.equal(workbuddyRealmOf("https://copilot.tencent.com/v2/chat"), "cn")
  assert.equal(workbuddyRealmOf("https://www.workbuddy.cn/v2"), "cn")
  // 不是已知域名时保持既有行为（当国内站）。
  assert.equal(workbuddyRealmOf("https://mirror.example/v1"), "cn")

  assert.equal(workbuddyRealmOfProvider(workbuddyGlobalProviderTemplate()), "global")
  assert.equal(workbuddyRealmOfProvider(workbuddyProviderTemplate()), "cn")
  assert.equal(
    workbuddyRealmOfProvider({
      id: "cloned-global",
      endpoints: [{ baseUrl: "https://www.workbuddy.ai/v2", apiKey: "" }],
    } as unknown as Provider),
    "global",
  )
})

test("国际版是独立供应商，地址与占位凭据都不与国内版共用", () => {
  const provider = workbuddyGlobalProviderTemplate()
  assert.equal(provider.id, WORKBUDDY_GLOBAL_PROVIDER_ID)
  assert.equal(provider.protocol, "openai-chat")
  assert.equal(provider.endpoints[0].baseUrl, WORKBUDDY_GLOBAL_API_BASE_URL)
  assert.equal(provider.endpoints[0].apiKey, WORKBUDDY_GLOBAL_CREDENTIAL_PLACEHOLDER)
  assert.equal(provider.reasoningDialect, "workbuddy-effort")
  assert.notEqual(provider.id, WORKBUDDY_PROVIDER_ID)
  assert.notEqual(WORKBUDDY_GLOBAL_API_BASE_URL, workbuddyProviderTemplate().endpoints[0].baseUrl)
  // 国际版也吃同一批静态头（X-Product / CLI 版本）。
  assert.equal(
    provider.headers.find((header) => header.key === "X-Product")?.value,
    "SaaS",
  )
  assert.equal(isWorkbuddyProvider(provider), true)
})

test("模型目录地址按 realm 分叉：国内 /v3/config，国际 /v2/enterprises/personal/models", () => {
  assert.equal(
    workbuddyCatalogUrl("https://www.workbuddy.ai/v2"),
    "https://www.workbuddy.ai/v2/enterprises/personal/models",
  )
  assert.equal(
    workbuddyCatalogUrl("https://www.workbuddy.ai/v2/chat/completions"),
    "https://www.workbuddy.ai/v2/enterprises/personal/models",
  )
  // 国内站口径不变。
  assert.equal(
    workbuddyCatalogUrl("https://www.codebuddy.cn/v2"),
    "https://www.codebuddy.cn/v3/config",
  )
})

test("国际站目录补上 extraModels（chat 直接认但目录不列的模型）", () => {
  const models = workbuddyCatalogModels(
    {
      code: 0,
      data: {
        models: [
          {
            id: "hy4-preview",
            name: "Hy4 preview",
            maxInputTokens: 1_000_000,
            supportsReasoning: true,
            supportsImages: true,
            supportsToolCall: true,
          },
        ],
      },
    },
    "global",
  )
  assert.deepEqual(
    models.map((model) => model.id),
    ["hy4-preview", "deepseek-v4.1-flash", "deepseek-v3"],
  )

  // 国内站不补 extraModels，口径不变。
  assert.deepEqual(
    workbuddyCatalogModels({ data: { models: [{ id: "hy3", maxInputTokens: 1000 }] } }, "cn").map(
      (model) => model.id,
    ),
    ["hy3"],
  )

  // 上游目录里已经有同名模型时不重复追加。
  const deduped = workbuddyCatalogModels(
    { code: 0, data: { models: [{ id: "deepseek-v3", maxInputTokens: 128_000 }] } },
    "global",
  )
  assert.deepEqual(
    deduped.map((model) => model.id),
    ["deepseek-v3", "deepseek-v4.1-flash"],
  )
})

test("目录信封带业务码时把上游原因带出来，国内站不带 code 不拦", () => {
  assert.equal(workbuddyCatalogError({ code: 0, data: {} }), "")
  assert.equal(workbuddyCatalogError({ data: {} }), "")
  assert.match(String(workbuddyCatalogError({ code: 11217, message: "未登录" })), /11217/)
  assert.match(String(workbuddyCatalogError({ code: 11115 })), /11115/)
})

test("预设规格与内置模型同源，国际版预设能直接铺出模型", () => {
  const specs = workbuddyPresetModelSpecs()
  assert.equal(specs.length, workbuddyPresetModels().length)
  assert.deepEqual(
    specs.map((spec) => spec.modelId),
    workbuddyPresetModels().map((model) => model.modelId),
  )
})
