import assert from "node:assert/strict"
import test from "node:test"

import { buildAnthropicRequest } from "./anthropic"
import {
  emptyToolContext,
  responsesToolsToChatTools,
} from "./codex-tool-proxy"
import { responsesToChatCompletions } from "./chat-compatible"

const anthropicTarget = {
  provider: {
    id: "provider-anthropic",
    name: "Anthropic Provider",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "test-key",
    headers: [],
    endpoints: [],
    timeoutMs: 60_000,
    enabled: true,
  },
  model: {
    id: "model-claude",
    name: "Claude",
    providerId: "provider-anthropic",
    modelId: "claude-fable-5",
    enabled: true,
    supportsReasoning: true,
    reasoningDialect: "none",
  },
  modelId: "claude-fable-5",
  requestedModel: "switchgate__model_claude",
  reasoning: "high",
  paused: false,
} as any

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
    id: "model-glm",
    name: "GLM",
    providerId: "provider-chat",
    modelId: "glm-5.3-flash",
    enabled: true,
    supportsReasoning: true,
    reasoningDialect: "glm-thinking",
  },
  modelId: "glm-5.3-flash",
  requestedModel: "switchgate__model_glm",
  reasoning: "high",
  paused: false,
} as any

function convert(body: unknown) {
  const converted = responsesToChatCompletions(body as any, chatTarget, {
    applyLanguagePolicy: false,
  })
  return converted.body
}

test("additional_tools carrier is not converted to a null-content message and its tools are lifted", () => {
  const body = convert({
    model: "glm-5.3-flash",
    input: [
      {
        type: "additional_tools",
        id: "at_1",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            description: "",
            tools: [
              {
                type: "function",
                name: "exec_command",
                description: "Run a shell command.",
                parameters: {
                  type: "object",
                  properties: { cmd: { type: "string" } },
                  required: ["cmd"],
                },
              },
            ],
          },
          {
            type: "function",
            name: "wait",
            description: "Waits on a yielded exec cell.",
            parameters: {
              type: "object",
              properties: { cell_id: { type: "string" } },
              required: ["cell_id"],
            },
          },
        ],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "You are Codex, a coding agent." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "你好" }],
      },
    ],
  })

  const messages = body.messages as any[]
  for (const [index, message] of messages.entries()) {
    assert.notEqual(message.content, null, `messages[${index}] must not have null content`)
    assert.notEqual(message.content, undefined, `messages[${index}] must not be missing content`)
  }
  assert.deepEqual(messages.map((m) => m.role), ["system", "user"])
  assert.equal(messages[0].content, "You are Codex, a coding agent.")

  const tools = body.tools as any[]
  const names = tools.map((t) => t.function.name)
  assert.ok(names.includes("functions__exec_command"), names.join(","))
  assert.ok(names.includes("wait"), names.join(","))
})

test("additional_tools carrier dedupes against top-level tools", () => {
  const body = convert({
    model: "glm-5.3-flash",
    tools: [
      {
        type: "function",
        name: "wait",
        description: "Top-level wait.",
        parameters: { type: "object", properties: {} },
      },
    ],
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "function",
            name: "wait",
            description: "Carried wait.",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  })

  const tools = body.tools as any[]
  assert.equal(tools.length, 1)
  assert.equal(tools[0].function.name, "wait")
  assert.equal(tools[0].function.description, "Top-level wait.")
})

test("additional_tools carrier does not split pending reasoning or tool calls", () => {
  const body = convert({
    model: "glm-5.3-flash",
    input: [
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "inspect both files together" }],
      },
      {
        type: "function_call",
        call_id: "call_first",
        name: "read_file",
        arguments: '{"path":"a.ts"}',
      },
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "function",
            name: "wait",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      {
        type: "function_call",
        call_id: "call_second",
        name: "read_file",
        arguments: '{"path":"b.ts"}',
      },
      {
        type: "function_call_output",
        call_id: "call_first",
        output: "a",
      },
      {
        type: "function_call_output",
        call_id: "call_second",
        output: "b",
      },
    ],
  })
  const messages = body.messages as any[]

  assert.deepEqual(messages.map((message: any) => message.role), [
    "assistant",
    "tool",
    "tool",
  ])
  assert.deepEqual(
    messages[0].tool_calls.map((call: any) => call.id),
    ["call_first", "call_second"],
  )
  assert.equal(messages[0].reasoning_content, "inspect both files together")
})

test("plain developer messages still convert without additional_tools carrier", () => {
  const body = convert({
    model: "glm-5.3-flash",
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Instructions." }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  })

  const messages = body.messages as any[]
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, "system")
  assert.equal(messages[0].content, "Instructions.")
  assert.equal(messages[1].role, "user")
  assert.equal("tools" in body, false)
})

test("missing tool description is omitted instead of serialized as empty string", () => {
  const context = emptyToolContext()
  const tools = responsesToolsToChatTools(
    [
      {
        type: "function",
        name: "no_desc",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "with_desc",
        description: "Has one",
        parameters: { type: "object", properties: {} },
      },
    ],
    context,
  )

  assert.equal(tools.length, 2)
  assert.equal("description" in tools[0].function, false)
  assert.equal(tools[1].function.description, "Has one")
})

test("additional_tools carrier tools are lifted into Anthropic conversion too", () => {
  const built = buildAnthropicRequest(anthropicTarget, "v1/responses", {
    model: "claude-fable-5",
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          {
            type: "function",
            name: "carried_tool",
            description: "A carried tool.",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  })

  const body = built.rewrittenBody as any
  const names = (body.tools || []).map((t: any) => t.name)
  assert.ok(names.includes("carried_tool"), names.join(","))
})
