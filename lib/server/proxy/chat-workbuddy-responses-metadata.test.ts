import assert from "node:assert/strict"
import test from "node:test"

import {
  chatCompletionToResponse,
  chatSseToResponsesSse,
  transformChatCompatibleResponse,
  type ChatCompatibleAdapter,
} from "./chat-compatible"

const toolContext = {
  customTools: {},
  functionTools: {},
  toolSearchTools: [],
  webSearchTools: [],
}

function sse(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function adapter(
  workbuddyResponsesMetadata: boolean,
): Extract<ChatCompatibleAdapter, { type: "chat_compatible" }> {
  return {
    type: "chat_compatible",
    source: "responses",
    requestIsStream: true,
    originalRequest: { model: "deepseek-v4.1-flash", stream: true },
    toolContext,
    workbuddyResponsesMetadata,
  }
}

function parseEvents(text: string) {
  return text
    .split(/\r?\n\r?\n/)
    .flatMap((frame) => {
      const data = frame
        .split(/\r?\n/)
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
      if (!data || data === "[DONE]") return []
      return [JSON.parse(data)]
    })
}

function finalMessageEvent(events: any[]) {
  return events.find(
    (event) =>
      event.type === "response.output_item.done" &&
      event.item?.type === "message",
  )?.item
}

function completedMessage(events: any[]) {
  return events
    .find((event) => event.type === "response.completed")
    ?.response?.output
    ?.find((item: any) => item.type === "message")
}

function streamEvents(workbuddyResponsesMetadata: boolean) {
  return parseEvents(chatSseToResponsesSse(
    sse({
      id: "chatcmpl_workbuddy",
      model: "deepseek-v4.1-flash",
      choices: [{ delta: { content: "任务完成。" } }],
    }) +
      sse({
        id: "chatcmpl_workbuddy",
        choices: [{ delta: {}, finish_reason: "stop" }],
      }) +
      "data: [DONE]\n\n",
    adapter(workbuddyResponsesMetadata),
  ).text)
}

test("WorkBuddy 流式最终消息在 done 和 completed 中都带 memoryCitation", () => {
  const events = streamEvents(true)
  const doneItem = finalMessageEvent(events)
  const completedItem = completedMessage(events)

  assert.equal(doneItem.phase, "final_answer")
  assert.equal(Object.hasOwn(doneItem, "memoryCitation"), true)
  assert.equal(doneItem.memoryCitation, null)
  assert.equal(completedItem.phase, "final_answer")
  assert.equal(Object.hasOwn(completedItem, "memoryCitation"), true)
  assert.equal(completedItem.memoryCitation, null)
  assert.equal(doneItem.id, completedItem.id)
  assert.equal(doneItem.content[0].text, completedItem.content[0].text)
})

test("普通 Chat 流式最终消息不新增 memoryCitation", () => {
  const events = streamEvents(false)
  const doneItem = finalMessageEvent(events)
  const completedItem = completedMessage(events)

  assert.equal(doneItem.phase, "final_answer")
  assert.equal(Object.hasOwn(doneItem, "memoryCitation"), false)
  assert.equal(Object.hasOwn(completedItem, "memoryCitation"), false)
})

test("WorkBuddy 非流式最终消息带 memoryCitation", () => {
  const response = chatCompletionToResponse(
    {
      id: "chatcmpl_workbuddy",
      model: "deepseek-v4.1-flash",
      choices: [{
        message: { role: "assistant", content: "任务完成。" },
        finish_reason: "stop",
      }],
    },
    { model: "deepseek-v4.1-flash" },
    toolContext,
    true,
  )
  const output = (response as { output: any[] }).output
  const message = output.find((item) => item.type === "message")

  assert.equal(message.phase, "final_answer")
  assert.equal(Object.hasOwn(message, "memoryCitation"), true)
  assert.equal(message.memoryCitation, null)
})

test("普通 Chat 非流式最终消息保持原字段", () => {
  const response = transformChatCompatibleResponse(
    {
      id: "chatcmpl_other",
      model: "deepseek-v4.1-flash",
      choices: [{
        message: { role: "assistant", content: "任务完成。" },
        finish_reason: "stop",
      }],
    },
    adapter(false),
    { recordHistory: false },
  )
  const output = (response as { output: any[] }).output
  const message = output.find((item) => item.type === "message")

  assert.equal(message.phase, "final_answer")
  assert.equal(Object.hasOwn(message, "memoryCitation"), false)
})

test("工具调用前的 WorkBuddy 消息仍标记为 commentary 并补齐元数据", () => {
  const events = parseEvents(chatSseToResponsesSse(
    sse({
      id: "chatcmpl_workbuddy_tool",
      model: "deepseek-v4.1-flash",
      choices: [{
        delta: {
          content: "我先检查文件。",
          tool_calls: [{
            index: 0,
            id: "call_check",
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":"Get-ChildItem"}' },
          }],
        },
      }],
    }) +
      sse({
        id: "chatcmpl_workbuddy_tool",
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
      }) +
      "data: [DONE]\n\n",
    adapter(true),
  ).text)
  const message = finalMessageEvent(events)

  assert.equal(message.phase, "commentary")
  assert.equal(message.memoryCitation, null)
  assert.equal(completedMessage(events).phase, "commentary")
  assert.equal(completedMessage(events).memoryCitation, null)
})
