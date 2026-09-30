import assert from "node:assert/strict"
import test from "node:test"

import { buildChatCompatibleRequest } from "./chat-compatible"

function target(providerId: string, baseUrl: string) {
  return {
    provider: {
      id: providerId,
      name: providerId,
      protocol: "openai-chat",
      baseUrl,
      apiKey: "test-key",
      headers: [],
      endpoints: [],
      timeoutMs: 60_000,
      enabled: true,
    },
    model: {
      id: "model-workbuddy",
      name: "WorkBuddy",
      providerId,
      modelId: "deepseek-v4.1-flash",
      enabled: true,
      supportsReasoning: true,
      reasoningDialect: "workbuddy-effort",
    },
    modelId: "deepseek-v4.1-flash",
    requestedModel: "switchgate__m-workbuddy-deepseek-v4-1-flash",
    reasoning: "low",
    paused: false,
  } as any
}

test("WorkBuddy Chat 透传把 developer 归一为 system", () => {
  const built = buildChatCompatibleRequest(
    target("prov-workbuddy", "https://www.codebuddy.cn/v2"),
    "v1/chat/completions",
    {
      model: "switchgate__m-workbuddy-deepseek-v4-1-flash",
      messages: [
        { role: "system", content: "必须使用中文。" },
        { role: "developer", content: "You are Codex." },
        { role: "user", content: "继续" },
      ],
      stream: false,
    },
  )

  const body = built.rewrittenBody as any
  assert.equal(built.adapter.type, "chat_compatible_passthrough")
  assert.deepEqual(body.messages.map((message: any) => message.role), [
    "system",
    "system",
    "user",
  ])
  assert.equal(body.stream, true)
})

test("非 WorkBuddy Chat 透传保留 developer 角色", () => {
  const built = buildChatCompatibleRequest(
    target("provider-chat", "https://example.com/v1"),
    "v1/chat/completions",
    {
      model: "switchgate__m-example",
      messages: [
        { role: "system", content: "必须使用中文。" },
        { role: "developer", content: "You are Codex." },
      ],
      stream: false,
    },
  )

  const body = built.rewrittenBody as any
  assert.equal(body.messages[1].role, "developer")
  assert.equal(body.stream, false)
})
