import assert from "node:assert/strict"
import test from "node:test"

import { buildChatCompatibleRequest } from "./chat-compatible"
import { normalizeWorkbuddyChatMessages } from "./chat-workbuddy-request"
import { buildProxyRequest } from "./request-builder"

const dshIdentity = "You are an AI agent powered by DeepSeek Harness."

function target(providerId: string, baseUrl: string) {
  return {
    provider: {
      id: providerId,
      name: providerId,
      protocol: "openai-chat",
      baseUrl,
      apiKey: "test-key",
      headers: [],
      bodyOverride: "",
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

test("WorkBuddy removes only the leading DSH identity without mutating history", () => {
  const instructions = "\r\n\r\nKeep every task constraint.  Preserve spacing.\n"
  const messages = [
    { role: "developer", content: `${dshIdentity}${instructions}`, name: "agent" },
    { role: "system", content: `Quoted example: ${dshIdentity}` },
    { role: "user", content: dshIdentity },
    { role: "assistant", content: dshIdentity },
    { role: "tool", content: dshIdentity, tool_call_id: "call-1" },
  ]
  const original = structuredClone(messages)
  const body = { messages }

  normalizeWorkbuddyChatMessages(body, target("prov-workbuddy", "https://www.codebuddy.cn/v2"))

  assert.deepEqual(body.messages, [
    { ...messages[0], role: "system", content: instructions },
    ...messages.slice(1),
  ])
  assert.deepEqual(messages, original)
  assert.strictEqual(body.messages[2], messages[2])
})

test("WorkBuddy preserves structured content and block metadata", () => {
  const first = {
    type: "text",
    text: `${dshIdentity}\nKeep the task.`,
    cache_control: { type: "ephemeral" },
  }
  const content = [first, { type: "text", text: dshIdentity }]
  const body = { messages: [{ role: "system", content }] }

  normalizeWorkbuddyChatMessages(body, target("prov-workbuddy", "https://www.codebuddy.cn/v2"))

  assert.deepEqual(body.messages[0].content, [
    { ...first, text: "\nKeep the task." },
    content[1],
  ])
  assert.equal(first.text, `${dshIdentity}\nKeep the task.`)
})

test("WorkBuddy Chat strips the DSH identity and retains tools and client stream mode", () => {
  const constraints = "\n\nKeep all task instructions."
  const tools = [{
    type: "function",
    function: { name: "check", description: dshIdentity, parameters: { type: "object" } },
  }]
  const built = buildChatCompatibleRequest(
    target("prov-workbuddy", "https://www.codebuddy.cn/v2"),
    "v1/chat/completions",
    {
      model: "client-model",
      messages: [
        { role: "developer", content: `${dshIdentity}${constraints}` },
        { role: "user", content: "Check the connection." },
      ],
      tools,
      stream: false,
    },
  )
  const body = built.rewrittenBody as any

  assert.ok(body.messages.some((message: any) => message.content === constraints))
  assert.equal(body.messages.some((message: any) => message.role === "developer"), false)
  assert.deepEqual(body.tools, tools)
  assert.equal(body.stream, true)
  assert.equal(built.adapter.requestIsStream, false)
})

test("WorkBuddy Responses conversion applies the same DSH normalization", () => {
  for (const [providerId, baseUrl] of [
    ["prov-workbuddy", "https://www.codebuddy.cn/v2"],
    ["prov-workbuddy-global", "https://www.workbuddy.ai/v2"],
  ]) {
    const built = buildChatCompatibleRequest(
      target(providerId, baseUrl),
      "v1/responses",
      {
        model: "client-model",
        instructions: `${dshIdentity}\nKeep the top-level instructions.`,
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: `${dshIdentity}\nKeep the developer instructions.` }],
          },
          { role: "user", content: "Check the connection." },
        ],
        stream: true,
      },
    )
    const body = built.rewrittenBody as any
    const systems = body.messages.filter((message: any) => message.role === "system")
    assert.equal(systems.length, 2)
    assert.ok(systems[0].content.startsWith("\nKeep the top-level instructions."))
    assert.equal(systems[1].content, "\nKeep the developer instructions.")
    assert.equal(body.stream, true)
    assert.equal(built.adapter.type, "chat_compatible")
  }
})

test("WorkBuddy preserves Codex identities and all their task instructions", () => {
  for (const identity of [
    "You are Codex, a coding agent based on GPT-5.",
    "You are Codex, an agent based on GPT-6.",
  ]) {
    const instructions = `${identity} Keep all task instructions.`
    const built = buildChatCompatibleRequest(
      target("prov-workbuddy", "https://www.codebuddy.cn/v2"),
      "v1/responses",
      {
        model: "client-model",
        input: [
          { role: "developer", content: [{ type: "input_text", text: instructions }] },
          { role: "user", content: "Check the connection." },
        ],
        stream: true,
      },
    )
    const body = built.rewrittenBody as any
    assert.ok(body.messages.some((message: any) => message.content === instructions))
  }
})

test("other providers retain the DSH identity", () => {
  const built = buildChatCompatibleRequest(
    target("provider-chat", "https://example.com/v1"),
    "v1/chat/completions",
    {
      model: "client-model",
      messages: [
        { role: "developer", content: `${dshIdentity}\nKeep the task.` },
        { role: "user", content: "Check the connection." },
      ],
      stream: true,
    },
  )
  const body = built.rewrittenBody as any
  assert.ok(body.messages.some((message: any) =>
    message.role === "developer" && message.content === `${dshIdentity}\nKeep the task.`,
  ))
})

test("raw Responses retains DSH and Codex identities without message normalization", () => {
  const rawTarget = target("prov-workbuddy", "https://www.codebuddy.cn/v2")
  rawTarget.provider.protocol = "openai-responses"
  rawTarget.provider.rawResponsesPassthrough = true
  rawTarget.reasoning = "auto"
  const request = {
    model: "client-model",
    instructions: `${dshIdentity}\nKeep the task.`,
    input: [{
      role: "developer",
      content: [{ type: "input_text", text: "You are Codex, a coding agent based on GPT-5." }],
    }],
    stream: true,
  }
  const original = structuredClone(request)
  const built = buildProxyRequest(rawTarget, "v1/responses", request)

  assert.deepEqual(built.rewrittenBody, { ...original, model: rawTarget.modelId })
  assert.deepEqual(request, original)
})
