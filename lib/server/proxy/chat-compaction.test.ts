import assert from "node:assert/strict"
import test from "node:test"

import {
  buildRemoteCompactionChatBody,
  chatCompletionToRemoteCompactionResponse,
  compactionItemToChatMessage,
  decodeLocalCompactionSummary,
  findRemoteCompactionTrigger,
} from "./chat-compaction"

test("识别 normal Responses 请求里的 compaction_trigger", () => {
  const trigger = findRemoteCompactionTrigger([
    { type: "message", role: "user", content: "历史" },
    { type: "compaction_trigger", instructions: "生成交接摘要" },
  ])

  assert.equal(trigger?.instructions, "生成交接摘要")
  assert.equal(findRemoteCompactionTrigger([{ type: "message", role: "user" }]), null)
})

test("远程压缩 Chat 请求移除工具并把历史 system 降为转录内容", () => {
  const body = buildRemoteCompactionChatBody(
    {
      model: "glm-5.3-flash",
      messages: [
        { role: "system", content: "只能使用 pwsh" },
        { role: "user", content: "修复问题" },
        { role: "assistant", content: "正在排查" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      tools: [{ type: "function", function: { name: "shell" } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
    },
    { type: "compaction_trigger", instructions: "保留下一步" },
  )

  assert.equal(body.stream, false)
  assert.equal(body.n, 1)
  assert.equal(Object.hasOwn(body, "tools"), false)
  assert.equal(Object.hasOwn(body, "tool_choice"), false)
  assert.equal(Object.hasOwn(body, "parallel_tool_calls"), false)
  assert.equal(Object.hasOwn(body, "stream_options"), false)
  assert.deepEqual(body.messages.map((message: { role: string }) => message.role), [
    "system",
    "assistant",
    "user",
    "assistant",
    "user",
  ])
  assert.match(body.messages[0].content, /保留下一步/u)
  assert.match(body.messages[1].content, /只能使用 pwsh/u)
})

test("Chat 摘要响应转换为可恢复的 compaction item", () => {
  const response = chatCompletionToRemoteCompactionResponse({
    id: "chatcmpl_1",
    model: "glm-5.3-flash",
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "当前主线：继续修复压缩。" },
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    },
  })

  assert.equal(response.output[0].type, "compaction")
  assert.equal(
    decodeLocalCompactionSummary(response.output[0].encrypted_content),
    "当前主线：继续修复压缩。",
  )
  assert.deepEqual(response.usage, {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    output_tokens_details: { reasoning_tokens: 0 },
  })
})

test("本地 compaction item 恢复为 assistant 历史", () => {
  const response = chatCompletionToRemoteCompactionResponse({
    choices: [{
      finish_reason: "stop",
      message: { role: "assistant", content: "下一步：运行测试。" },
    }],
  })

  const message = compactionItemToChatMessage(response.output[0])

  assert.equal(message?.role, "assistant")
  assert.match(message?.content || "", /下一步：运行测试/u)
  assert.equal(
    compactionItemToChatMessage({
      type: "compaction",
      encrypted_content: "upstream-opaque-value",
    }),
    null,
  )
})

test("拒绝空摘要和被截断的摘要", () => {
  assert.throws(
    () =>
      chatCompletionToRemoteCompactionResponse({
        choices: [{ finish_reason: "stop", message: { content: "" } }],
      }),
    /压缩摘要为空/u,
  )
  assert.throws(
    () =>
      chatCompletionToRemoteCompactionResponse({
        choices: [{ finish_reason: "length", message: { content: "半截摘要" } }],
      }),
    /达到输出上限/u,
  )
})
