import assert from "node:assert/strict"
import test from "node:test"

import { foldChatSsePayload, parseChatSseFrames } from "./chat-sse-fold"

function chunk(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

const SSE_SAMPLE =
  chunk({
    id: "abc123",
    model: "hy4-preview",
    object: "chat.completion.chunk",
    created: 1790224087,
    choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "" } }],
    usage: null,
  }) +
  chunk({
    id: "abc123",
    model: "hy4-preview",
    choices: [{ index: 0, delta: { content: "", reasoning_content: "先看天气" } }],
  }) +
  chunk({
    id: "abc123",
    model: "hy4-preview",
    choices: [{ index: 0, delta: { content: "北京", reasoning_content: "" } }],
  }) +
  chunk({
    id: "abc123",
    model: "hy4-preview",
    choices: [{
      index: 0,
      delta: {
        content: "晴。",
        tool_calls: [{ id: "chatcmpl-tool-1", type: "function", function: { name: "get_weather", arguments: "" }, index: 0 }],
      },
    }],
  }) +
  chunk({
    id: "abc123",
    model: "hy4-preview",
    choices: [{ index: 0, delta: { tool_calls: [{ function: { name: "", arguments: "{\"city\":\"北京\"}" }, index: 0 }] } }],
  }) +
  chunk({
    id: "abc123",
    model: "hy4-preview",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 190, completion_tokens: 49, total_tokens: 239 },
  }) +
  "data: [DONE]\n\n"

test("整段 chat SSE 折成一条 chat completion", () => {
  const folded = foldChatSsePayload(SSE_SAMPLE) as Record<string, any>
  assert.equal(folded.id, "abc123")
  assert.equal(folded.object, "chat.completion")
  assert.equal(folded.model, "hy4-preview")
  assert.equal(folded.created, 1790224087)
  assert.equal(folded.choices[0].finish_reason, "tool_calls")
  assert.equal(folded.choices[0].message.role, "assistant")
  assert.equal(folded.choices[0].message.content, "北京晴。")
  assert.equal(folded.choices[0].message.reasoning_content, "先看天气")
  assert.deepEqual(folded.choices[0].message.tool_calls, [
    {
      id: "chatcmpl-tool-1",
      type: "function",
      function: { name: "get_weather", arguments: "{\"city\":\"北京\"}" },
    },
  ])
  assert.deepEqual(folded.usage, {
    prompt_tokens: 190,
    completion_tokens: 49,
    total_tokens: 239,
  })
})

test("不是 SSE 的响应原样返回", () => {
  assert.equal(foldChatSsePayload('{"error":{"message":"boom"}}'), '{"error":{"message":"boom"}}')
  assert.equal(foldChatSsePayload(null), null)
  assert.deepEqual(foldChatSsePayload({ choices: [] }), { choices: [] })
})

test("只带 data 字样但没有帧的文本不折叠", () => {
  assert.equal(foldChatSsePayload("no data: here"), "no data: here")
  assert.equal(
    foldChatSsePayload("event: ping\n\ndata: not-json\n\n"),
    "event: ping\n\ndata: not-json\n\n",
  )
})

test("流中途报错时把错误体交回上层", () => {
  const folded = foldChatSsePayload(
    chunk({ choices: [{ index: 0, delta: { content: "部分" } }] }) +
      chunk({ error: { message: "上游中断", type: "upstream_error" } }),
  ) as Record<string, any>
  assert.deepEqual(folded, { error: { message: "上游中断", type: "upstream_error" } })
})

test("帧解析保留事件名并跳过空帧", () => {
  assert.deepEqual(parseChatSseFrames("event: response.output_text.delta\ndata: {\"a\":1}\n\n\n\n"), [
    { event: "response.output_text.delta", payload: "{\"a\":1}" },
  ])
})
