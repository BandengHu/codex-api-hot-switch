import assert from "node:assert/strict"
import test from "node:test"

import { responsesToChatCompletions } from "./chat-compatible"

// 对齐 cc-switch #7280（修复 #6529）：同一 Responses 回合里的 commentary 消息与紧随其后的
// 工具调用必须落在同一条 Chat assistant 消息里。拆成两条 assistant 消息时，Chat 模型会模仿
// 第一条纯文本消息、把它当成完整回合，在工具调用之前就返回 finish_reason=stop —— 长任务
// 于是在一句进度汇报后戛然而止。

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

function convert(input: unknown[]) {
  // 关掉输出语言策略注入：那会额外追加一条 user 消息（本地既有行为，与本次合并无关），
  // 开着会干扰这里的消息形状断言。
  const converted = responsesToChatCompletions({ model: "glm-5.3-flash", input }, chatTarget, {
    applyLanguagePolicy: false,
  })
  return converted.body.messages as any[]
}

function roles(messages: any[]) {
  return messages.map((message) => message.role)
}

const commentary = (text: string) => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
})

const functionCall = (callId: string, reasoning?: string) => ({
  type: "function_call",
  call_id: callId,
  name: "exec_command",
  arguments: "{}",
  ...(reasoning ? { reasoning_content: reasoning } : {}),
})

const functionOutput = (callId: string, output: unknown) => ({
  type: "function_call_output",
  call_id: callId,
  output,
})

test("紧邻的 commentary 与工具调用合并进同一条 assistant 消息", () => {
  const messages = convert([
    { type: "reasoning", summary: [{ type: "summary_text", text: "need to update the file" }] },
    commentary("Part 1 written. Appending sections 4-5."),
    functionCall("call_1", "need to update the file"),
    functionOutput("call_1", "Success"),
  ])

  assert.deepEqual(roles(messages), ["assistant", "tool"])
  assert.equal(messages[0].content, "Part 1 written. Appending sections 4-5.")
  assert.equal(messages[0].tool_calls.length, 1)
  assert.equal(messages[0].tool_calls[0].id, "call_1")
  assert.equal(messages[0].reasoning_content, "need to update the file")
  assert.equal(messages[1].tool_call_id, "call_1")
})

test("并行调用的重复推理段按段去重", () => {
  const messages = convert([
    { type: "reasoning", summary: [{ type: "summary_text", text: "need to update the file" }] },
    commentary("Part 1 written. Appending sections 4-5."),
    functionCall("call_1", "need to update the file"),
    functionCall("call_2", "second section planning"),
    functionOutput("call_1", "Success 1"),
    functionOutput("call_2", "Success 2"),
  ])

  assert.deepEqual(roles(messages), ["assistant", "tool", "tool"])
  assert.equal(messages[0].reasoning_content, "need to update the file\n\nsecond section planning")
})

test("前一条 assistant 与 user 边界不会被跨过去合并", () => {
  const messages = convert([
    commentary("Done for now."),
    { type: "message", role: "user", content: "Continue with the next file." },
    functionCall("call_next"),
    functionOutput("call_next", "Next result"),
  ])

  assert.deepEqual(roles(messages), ["assistant", "user", "assistant", "tool"])
  assert.equal(messages[0].tool_calls, undefined)
  assert.equal(messages[0].content, "Done for now.")
  assert.equal(messages[2].tool_calls[0].id, "call_next")
})

test("commentary 与调用之间夹着 reasoning item 时仍能合并", () => {
  const messages = convert([
    commentary("Part 1 written. Appending sections 4-5."),
    { type: "reasoning", summary: [{ type: "summary_text", text: "need to update the file" }] },
    functionCall("call_1", "need to update the file"),
    functionOutput("call_1", "Success"),
  ])

  assert.deepEqual(roles(messages), ["assistant", "tool"])
  assert.equal(messages[0].content, "Part 1 written. Appending sections 4-5.")
  assert.equal(messages[0].tool_calls[0].id, "call_1")
  assert.equal(messages[0].reasoning_content, "need to update the file")
})

test("合并后没有推理内容时仍补上占位符", () => {
  const messages = convert([
    commentary("Running the build now."),
    functionCall("call_build"),
    functionOutput("call_build", "Build succeeded"),
  ])

  assert.deepEqual(roles(messages), ["assistant", "tool"])
  assert.equal(messages[0].content, "Running the build now.")
  assert.equal(messages[0].tool_calls[0].id, "call_build")
  assert.equal(messages[0].reasoning_content, "tool call")
})

test("custom_tool_call 与 commentary 合并", () => {
  const messages = convert([
    commentary("Applying the next patch."),
    {
      type: "custom_tool_call",
      id: "ctc_1",
      call_id: "call_patch",
      name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
    },
    { type: "custom_tool_call_output", call_id: "call_patch", output: { text: "Success" } },
  ])

  assert.deepEqual(roles(messages), ["assistant", "tool"])
  assert.equal(messages[0].content, "Applying the next patch.")
  assert.equal(messages[0].tool_calls[0].id, "call_patch")
  assert.equal(messages[1].tool_call_id, "call_patch")
})

test("多轮历史里除最终答案外不存在纯文本 assistant 消息", () => {
  const input: unknown[] = [{ type: "message", role: "user", content: "Fix the failing build." }]
  for (let index = 1; index <= 3; index += 1) {
    const callId = `call_round_${index}`
    const reasoning = `round ${index} reasoning`
    input.push({ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] })
    input.push(commentary(`Step ${index}: checking the logs.`))
    input.push(functionCall(callId, reasoning))
    input.push(functionOutput(callId, `round ${index} result`))
  }
  input.push(commentary("Build fixed."))

  const messages = convert(input)

  assert.deepEqual(roles(messages), [
    "user",
    "assistant",
    "tool",
    "assistant",
    "tool",
    "assistant",
    "tool",
    "assistant",
  ])
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || index + 1 >= messages.length) return
    assert.ok(
      Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
      `第 ${index} 条 assistant 必须带 tool_calls`,
    )
  })
  assert.equal(messages[1].content, "Step 1: checking the logs.")
  assert.equal(messages[1].tool_calls[0].id, "call_round_1")
  assert.equal(messages[1].reasoning_content, "round 1 reasoning")
  assert.equal(messages[7].content, "Build fixed.")
  assert.equal(messages[7].tool_calls, undefined)
})

// 以下两条对齐 cc-switch #5508（修复 #5506）：reasoning 必须前向附挂给它自己的
// assistant 消息；只有「真正的尾部」才允许回溯附挂。此前 r2 会被拼进 m1、
// m2 反而丢掉 reasoning_content，思考型模型因此多轮"断片"。

test("reasoning 前向附挂到其后的 assistant，不回溯污染上一条", () => {
  const messages = convert([
    { type: "reasoning", summary: [{ type: "summary_text", text: "first thought" }] },
    commentary("First answer."),
    { type: "reasoning", summary: [{ type: "summary_text", text: "second thought" }] },
    commentary("Second answer."),
    { type: "message", role: "user", content: "Continue" },
  ])

  assert.equal(messages[0].role, "assistant")
  assert.equal(messages[0].content, "First answer.")
  assert.equal(messages[0].reasoning_content, "first thought")
  assert.equal(messages[1].role, "assistant")
  assert.equal(messages[1].content, "Second answer.")
  assert.equal(messages[1].reasoning_content, "second thought")
  assert.equal(messages[2].role, "user")
  assert.equal(messages[2].reasoning_content, undefined)
})

test("工具调用后的最终答复保留自己的 reasoning", () => {
  const messages = convert([
    { type: "reasoning", summary: [{ type: "summary_text", text: "need to read a file" }] },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    },
    functionOutput("call_1", "Readme content"),
    { type: "reasoning", summary: [{ type: "summary_text", text: "now I can answer" }] },
    commentary("The file says hello."),
    { type: "message", role: "user", content: "Continue" },
  ])

  assert.equal(messages[0].role, "assistant")
  assert.equal(messages[0].tool_calls[0].id, "call_1")
  assert.equal(messages[0].reasoning_content, "need to read a file")
  assert.equal(messages[1].role, "tool")
  assert.equal(messages[2].role, "assistant")
  assert.equal(messages[2].content, "The file says hello.")
  assert.equal(messages[2].reasoning_content, "now I can answer")
  assert.equal(messages[3].role, "user")
  assert.equal(messages[3].reasoning_content, undefined)
})

test("尾部 reasoning 在回合边界回溯附挂到上一条 assistant", () => {
  const messages = convert([
    {
      type: "message",
      role: "assistant",
      reasoning_content: "Embedded thought.",
      content: "Done.",
    },
    { type: "reasoning", summary: [{ type: "summary_text", text: "Trailing thought." }] },
    { type: "message", role: "user", content: "Continue" },
  ])

  assert.equal(messages[0].role, "assistant")
  assert.equal(messages[0].content, "Done.")
  assert.equal(messages[0].reasoning_content, "Embedded thought.\n\nTrailing thought.")
  assert.equal(messages[1].role, "user")
  assert.equal(messages[1].reasoning_content, undefined)
})
