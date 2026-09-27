import assert from "node:assert/strict"
import test from "node:test"

import { buildAlphaSearchRequest } from "./alpha-search"

function target(baseUrl: string, protocol = "openai-responses") {
  return {
    provider: {
      id: "provider-search",
      name: "Search Provider",
      protocol,
      baseUrl,
      apiKey: "test-key",
      headers: [],
      endpoints: [],
      timeoutMs: 60_000,
      enabled: true,
    },
    modelId: "gpt-5.6-sol",
    requestedModel: "switchgate__search",
    reasoning: "off",
    paused: false,
  } as any
}

test("Alpha Search 使用版本化 base URL 并保留查询参数", () => {
  const built = buildAlphaSearchRequest(
    target("https://relay.example/v1"),
    "v1/alpha/search?client_version=0.155.0",
    { model: "client-model", query: "latest release" },
  )

  assert.equal(
    built.url,
    "https://relay.example/v1/alpha/search?client_version=0.155.0",
  )
  assert.deepEqual(built.rewrittenBody, {
    model: "gpt-5.6-sol",
    query: "latest release",
  })
})

test("Alpha Search 从完整 Responses URL 推导同级端点", () => {
  const built = buildAlphaSearchRequest(
    target("https://relay.example/backend-api/codex/responses?api-version=2026-09"),
    "v1/alpha/search?client_version=0.155.0",
    { query: "release" },
  )

  assert.equal(
    built.url,
    "https://relay.example/backend-api/codex/alpha/search?api-version=2026-09&client_version=0.155.0",
  )
  assert.deepEqual(built.rewrittenBody, { query: "release" })
})

test("Alpha Search 不允许误发到 Chat 供应商", () => {
  assert.throws(
    () =>
      buildAlphaSearchRequest(
        target("https://chat.example/v1", "openai-chat"),
        "v1/alpha/search",
        { query: "release" },
      ),
    /只能转发到 OpenAI Responses/,
  )
})
