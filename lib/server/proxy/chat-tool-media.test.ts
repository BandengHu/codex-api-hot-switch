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
    modelId: "chat-model",
    enabled: true,
    supportsReasoning: false,
  },
  modelId: "chat-model",
  requestedModel: "switchgate__model_chat",
  reasoning: "off",
  paused: false,
} as any

function convert(input: unknown[]) {
  return responsesToChatCompletions(
    { model: "chat-model", input },
    chatTarget,
    { applyLanguagePolicy: false },
  ).body.messages as any[]
}

function imagePart(data: string) {
  return {
    type: "input_image",
    image_url: {
      url: `data:image/png;base64,${data}`,
      detail: "original",
    },
  }
}

function functionCall(callId: string, name = "view_image") {
  return {
    type: "function_call",
    call_id: callId,
    name,
    arguments: "{}",
  }
}

function functionOutput(callId: string, output: unknown) {
  return {
    type: "function_call_output",
    call_id: callId,
    output,
  }
}

test("连续媒体工具结果合并后在下一条消息前统一 flush", () => {
  const messages = convert([
    functionCall("call_1"),
    functionCall("call_2"),
    functionOutput("call_1", [imagePart("AAAA")]),
    functionOutput("call_2", [imagePart("BBBB")]),
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "继续" }],
    },
  ])

  assert.deepEqual(messages.map((message) => message.role), [
    "assistant",
    "tool",
    "tool",
    "user",
    "user",
  ])
  assert.equal(messages[0].tool_calls.length, 2)

  const mediaMessage = messages[3]
  assert.equal(mediaMessage.content.length, 4)
  assert.match(mediaMessage.content[0].text, /call_1/)
  assert.equal(mediaMessage.content[1].type, "image_url")
  assert.equal(mediaMessage.content[1].image_url.detail, "auto")
  assert.match(mediaMessage.content[2].text, /call_2/)
  assert.equal(mediaMessage.content[3].type, "image_url")
  assert.equal(messages[4].content, "继续")
})

test("tool_search_output 媒体剥离后仍保留完整条目结构", () => {
  const messages = convert([
    {
      type: "tool_search_call",
      call_id: "call_search",
      arguments: { query: "test" },
    },
    {
      type: "tool_search_output",
      call_id: "call_search",
      status: "completed",
      tools: [{ type: "function", name: "loaded_tool" }],
      output: [imagePart("CCCC")],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "继续" }],
    },
  ])

  assert.deepEqual(messages.map((message) => message.role), [
    "assistant",
    "tool",
    "user",
    "user",
  ])

  const toolOutput = JSON.parse(messages[1].content)
  assert.equal(toolOutput.type, "tool_search_output")
  assert.equal(toolOutput.call_id, "call_search")
  assert.equal(toolOutput.status, "completed")
  assert.equal(toolOutput.tools[0].name, "loaded_tool")
  assert.equal(toolOutput.output[0].type, "text")
  assert.match(toolOutput.output[0].text, /media moved/)

  assert.match(messages[2].content[0].text, /call_search/)
  assert.equal(messages[2].content[1].type, "image_url")
  assert.equal(messages[2].content[1].image_url.detail, "auto")
})
