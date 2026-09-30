import assert from "node:assert/strict"
import test from "node:test"

import { responsesToChatCompletions } from "./chat-compatible"

const chatTarget = {
  provider: {
    id: "provider-chat",
    name: "Chat Provider",
    protocol: "openai-chat",
    baseUrl: "https://example.com/v1",
    apiKey: "test-key",
    headers: [],
    endpoints: [],
    timeoutMs: 60_000,
    enabled: true,
  },
  model: {
    id: "model-chat",
    name: "Chat Model",
    providerId: "provider-chat",
    modelId: "example-model",
    enabled: true,
    supportsReasoning: false,
    reasoningDialect: "none",
  },
  modelId: "example-model",
  requestedModel: "switchgate__model_chat",
  reasoning: "off",
  paused: false,
} as any

test("Responses 转 Chat 时保留中途 developer/system 消息原位", () => {
  const converted = responsesToChatCompletions(
    {
      model: "example-model",
      instructions: "You are Codex.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Start" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Working" }],
        },
        {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<total_tokens>14963538 tokens left</total_tokens>",
            },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue" }],
        },
      ],
    },
    chatTarget,
    { applyLanguagePolicy: false },
  )

  assert.deepEqual(
    converted.body.messages.map((message: any) => message.role),
    ["system", "user", "assistant", "system", "user"],
  )
  assert.equal(converted.body.messages[0].content, "You are Codex.")
  assert.equal(
    converted.body.messages[3].content,
    "<total_tokens>14963538 tokens left</total_tokens>",
  )
})
