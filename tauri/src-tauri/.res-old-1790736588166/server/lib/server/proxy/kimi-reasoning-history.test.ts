import assert from "node:assert/strict"
import test from "node:test"

import { buildAnthropicRequest } from "./anthropic"
import { responsesToChatCompletions } from "./chat-compatible"

function target(protocol: "anthropic" | "openai-chat") {
  return {
    provider: {
      id: `provider-${protocol}`,
      name: "Kimi",
      protocol,
      baseUrl: "https://api.kimi.com/coding/v1",
      apiKey: "test-key",
      headers: [],
      endpoints: [],
      timeoutMs: 60_000,
      reasoningDialect: "auto",
      enabled: true,
    },
    model: {
      id: "model-kimi",
      name: "Kimi K3",
      providerId: `provider-${protocol}`,
      modelId: "kimi-k3",
      enabled: true,
      supportsReasoning: true,
      reasoningDialect: "inherit",
    },
    modelId: "kimi-k3",
    requestedModel: "switchgate__kimi",
    reasoning: "high",
    paused: false,
  } as any
}

function toolCallInput() {
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Read the file." }],
    },
    {
      type: "function_call",
      call_id: "call_read",
      name: "read_file",
      arguments: "{\"path\":\"a.txt\"}",
    },
    {
      type: "function_call_output",
      call_id: "call_read",
      output: "file contents",
    },
  ]
}

test("Kimi Chat 工具历史不再补 synthetic reasoning_content", () => {
  const converted = responsesToChatCompletions(
    {
      model: "kimi-k3",
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      input: toolCallInput(),
    },
    target("openai-chat"),
    { applyLanguagePolicy: false },
  )
  const assistant = converted.body.messages.find(
    (message: any) => message.role === "assistant",
  )

  assert.equal(assistant.tool_calls[0].function.name, "read_file")
  assert.equal(assistant.reasoning_content, undefined)
})

test("Kimi Anthropic 工具历史不再插入 synthetic thinking 块", () => {
  const built = buildAnthropicRequest(
    target("anthropic"),
    "v1/responses",
    {
      model: "kimi-k3",
      input: toolCallInput(),
    },
  )
  const body = built.rewrittenBody as any
  const assistant = body.messages.find(
    (message: any) => message.role === "assistant",
  )

  assert.deepEqual(
    assistant.content.map((block: any) => block.type),
    ["tool_use"],
  )
})
