import assert from "node:assert/strict"
import test from "node:test"

import { buildChatCompatibleRequest } from "./chat-compatible"
import { normalizeWorkbuddyChatMessages } from "./chat-workbuddy-request"
import { buildProxyRequest } from "./request-builder"

const dshIdentity = "You are an AI agent powered by DeepSeek Harness."
const dshGuiIdentity =
  "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names."
const dshPathReference = "Tokens prefixed with @ are paths the user explicitly referenced."
const workbuddyPathReference =
  "References beginning with @ identify paths explicitly mentioned by the user."

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

test("WorkBuddy removes only the verified GUI identity and preserves task and history content", () => {
  const before = "\r\n\r\nThe runtime context names the DeepSeek Harness implementation checkout.\n\n"
  const after = " When the user refers to this GUI, use the runtime context URL.  Keep all constraints.\n"
  for (const role of ["system", "developer"]) {
    const messages = [
      { role, content: `${dshIdentity}${before}${dshGuiIdentity}${after}`, name: "agent" },
      { role: "system", content: dshGuiIdentity.replace("Web GUI", "CLI") },
      { role: "user", content: dshGuiIdentity },
      { role: "assistant", content: dshGuiIdentity },
      { role: "tool", content: dshGuiIdentity, tool_call_id: "call-1" },
    ]
    const original = structuredClone(messages)
    const body = { messages }

    normalizeWorkbuddyChatMessages(body, target("prov-workbuddy", "https://www.codebuddy.cn/v2"))

    assert.deepEqual(body.messages, [
      { ...messages[0], role: "system", content: `${before}${after}` },
      ...messages.slice(1),
    ])
    assert.deepEqual(messages, original)
    for (let index = 1; index < messages.length; index++) {
      assert.strictEqual(body.messages[index], messages[index])
    }
    const normalized = structuredClone(body)
    normalizeWorkbuddyChatMessages(body, target("prov-workbuddy", "https://www.codebuddy.cn/v2"))
    assert.deepEqual(body, normalized)
  }
})

test("WorkBuddy GUI identity handling preserves structured text metadata and other blocks", () => {
  const remainder = "\n\nKeep the exact runtime path and GUI instructions.  \r\n"
  const text = `${dshIdentity}\n${dshGuiIdentity}${remainder}`
  for (const first of [
    text,
    { type: "text", text, cache_control: { type: "ephemeral" } },
    { type: "input_text", text, metadata: { source: "runtime" } },
  ]) {
    const content = [
      first,
      { type: "text", text: dshIdentity },
      { type: "image_url", image_url: { url: "https://example.com/gui.png" } },
    ]
    const original = structuredClone(content)
    const body = { messages: [{ role: "system", content }] }

    normalizeWorkbuddyChatMessages(body, target("prov-workbuddy", "https://www.codebuddy.cn/v2"))

    assert.deepEqual(body.messages[0].content, [
      typeof first === "string" ? `\n${remainder}` : { ...first, text: `\n${remainder}` },
      ...content.slice(1),
    ])
    assert.deepEqual(content, original)
    assert.strictEqual(body.messages[0].content[1], content[1])
    assert.strictEqual(body.messages[0].content[2], content[2])
  }
})

test("WorkBuddy removes the GUI identity without requiring a leading DSH identity", () => {
  const before = "Keep the original system instructions.\n\n"
  const after = "\nPreserve the runtime context."
  const body = { messages: [{ role: "system", content: `${before}${dshGuiIdentity}${after}` }] }

  normalizeWorkbuddyChatMessages(body, target("prov-workbuddy", "https://www.codebuddy.cn/v2"))

  assert.equal(body.messages[0].content, `${before}${after}`)
})

test("WorkBuddy rephrases only the verified path instruction without changing history", () => {
  const before = "\r\nKeep the original instructions.  "
  const after = "\n\nPreserve @src/main.ts and every path resolution rule.  \r\n"
  for (const role of ["system", "developer"]) {
    const messages = [
      { role, content: `${before}${dshPathReference}${after}`, name: "agent" },
      { role: "system", content: dshPathReference.replace("Tokens", "References") },
      { role: "user", content: dshPathReference },
      { role: "assistant", content: dshPathReference },
      { role: "tool", content: dshPathReference, tool_call_id: "call-1" },
    ]
    const original = structuredClone(messages)
    const body = { messages }

    normalizeWorkbuddyChatMessages(body, target("prov-workbuddy", "https://www.codebuddy.cn/v2"))

    assert.deepEqual(body.messages, [
      { ...messages[0], role: "system", content: `${before}${workbuddyPathReference}${after}` },
      ...messages.slice(1),
    ])
    assert.deepEqual(messages, original)
    for (let index = 1; index < messages.length; index++) {
      assert.strictEqual(body.messages[index], messages[index])
    }
    const normalized = structuredClone(body)
    normalizeWorkbuddyChatMessages(body, target("prov-workbuddy", "https://www.codebuddy.cn/v2"))
    assert.deepEqual(body, normalized)
  }
})

test("WorkBuddy path instruction handling preserves structured metadata and later blocks", () => {
  const before = "\nKeep every task constraint.\n"
  const after = "\nResolve relative paths against the workspace."
  const text = `${before}${dshPathReference}${after}`
  for (const first of [
    text,
    { type: "text", text, cache_control: { type: "ephemeral" } },
    { type: "input_text", text, metadata: { source: "runtime" } },
  ]) {
    const content = [first, { type: "text", text: dshPathReference }]
    const original = structuredClone(content)
    const body = { messages: [{ role: "system", content }] }

    normalizeWorkbuddyChatMessages(body, target("prov-workbuddy", "https://www.codebuddy.cn/v2"))

    const expected = `${before}${workbuddyPathReference}${after}`
    assert.deepEqual(body.messages[0].content, [
      typeof first === "string" ? expected : { ...first, text: expected },
      content[1],
    ])
    assert.deepEqual(content, original)
    assert.strictEqual(body.messages[0].content[1], content[1])
  }
})

test("WorkBuddy Chat strips the DSH identity and retains tools and client stream mode", () => {
  const constraints = `\n\n${dshPathReference}\nKeep all task instructions.`
  const expectedConstraints = `\n\n${workbuddyPathReference}\nKeep all task instructions.`
  const tools = [{
    type: "function",
    function: {
      name: "check",
      description: `${dshIdentity}\n${dshGuiIdentity}\n${dshPathReference}`,
      parameters: { type: "object" },
    },
  }]
  const built = buildChatCompatibleRequest(
    target("prov-workbuddy", "https://www.codebuddy.cn/v2"),
    "v1/chat/completions",
    {
      model: "client-model",
      messages: [
        { role: "developer", content: `${dshIdentity}${dshGuiIdentity}${constraints}` },
        { role: "user", content: "Check the connection." },
      ],
      tools,
      stream: false,
    },
  )
  const body = built.rewrittenBody as any

  assert.ok(body.messages.some((message: any) => message.content === expectedConstraints))
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
        instructions: `${dshIdentity}${dshGuiIdentity}\n${dshPathReference}\nKeep the top-level instructions.`,
        input: [
          {
            type: "message",
            role: "developer",
            content: [{
              type: "input_text",
              text: `${dshIdentity}${dshGuiIdentity}\n${dshPathReference}\nKeep the developer instructions.`,
            }],
          },
          { role: "user", content: "Check the connection." },
        ],
        stream: true,
      },
    )
    const body = built.rewrittenBody as any
    const systems = body.messages.filter((message: any) => message.role === "system")
    assert.equal(systems.length, 2)
    assert.ok(systems[0].content.startsWith(`\n${workbuddyPathReference}\nKeep the top-level instructions.`))
    assert.equal(systems[1].content, `\n${workbuddyPathReference}\nKeep the developer instructions.`)
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

test("other providers retain the DSH identities and path instruction", () => {
  const instructions = `${dshIdentity}${dshGuiIdentity}\n${dshPathReference}\nKeep the task.`
  const built = buildChatCompatibleRequest(
    target("provider-chat", "https://example.com/v1"),
    "v1/chat/completions",
    {
      model: "client-model",
      messages: [
        { role: "developer", content: instructions },
        { role: "user", content: "Check the connection." },
      ],
      stream: true,
    },
  )
  const body = built.rewrittenBody as any
  assert.ok(body.messages.some((message: any) =>
    message.role === "developer" && message.content === instructions,
  ))
})

test("raw Responses retains DSH and Codex identities without message normalization", () => {
  const rawTarget = target("prov-workbuddy", "https://www.codebuddy.cn/v2")
  rawTarget.provider.protocol = "openai-responses"
  rawTarget.provider.rawResponsesPassthrough = true
  rawTarget.reasoning = "auto"
  const request = {
    model: "client-model",
    instructions: `${dshIdentity}${dshGuiIdentity}\n${dshPathReference}\nKeep the task.`,
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

  const chatBody = {
    messages: [{ role: "developer", content: `${dshIdentity}${dshGuiIdentity}\n${dshPathReference}\nKeep the task.` }],
  }
  const originalChat = structuredClone(chatBody)
  normalizeWorkbuddyChatMessages(chatBody, rawTarget)
  assert.deepEqual(chatBody, originalChat)
})
