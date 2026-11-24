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
  const messages =
    events
    .find((event) => event.type === "response.completed")
    ?.response?.output
    ?.filter((item: any) => item.type === "message") ?? []
  return messages.find((item: any) => item.phase === "final_answer") ?? messages.at(-1)
}

function completedMessages(events: any[]) {
  return events
    .find((event) => event.type === "response.completed")
    ?.response?.output
    ?.filter((item: any) => item.type === "message") ?? []
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

test("WorkBuddy 普通回答从创建起就是 final_answer 并补齐 memoryCitation", () => {
  const events = streamEvents(true)
  const doneItem = finalMessageEvent(events)
  const completedItem = completedMessage(events)
  const addedItem = events.find(
    (event) =>
      event.type === "response.output_item.added" &&
      event.item?.type === "message",
  )?.item

  assert.equal(Object.hasOwn(addedItem, "phase"), false)
  assert.equal(Object.hasOwn(addedItem, "memoryCitation"), true)
  assert.equal(addedItem.memoryCitation, null)
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
  const addedItem = events.find(
    (event) =>
      event.type === "response.output_item.added" &&
      event.item?.type === "message",
  )?.item

  assert.equal(Object.hasOwn(addedItem, "phase"), false)
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

test("WorkBuddy 工具调用前的消息以 commentary 结束并补齐元数据", () => {
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
  const addedMessage = events.find(
    (event) =>
      event.type === "response.output_item.added" &&
      event.item?.type === "message",
  )?.item
  const messages = events
    .filter(
      (event) =>
        event.type === "response.output_item.done" &&
        event.item?.type === "message",
    )
    .map((event) => event.item)
  const completedMessageItems = completedMessages(events)

  assert.equal(Object.hasOwn(addedMessage, "phase"), false)
  assert.equal(addedMessage.memoryCitation, null)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].phase, "commentary")
  assert.equal(messages[0].memoryCitation, null)
  assert.equal(completedMessageItems.length, 1)
  assert.equal(completedMessageItems[0].phase, "commentary")
  assert.equal(completedMessageItems[0].memoryCitation, null)
})

test("WorkBuddy 工具调用后的回答使用独立且稳定的 final_answer", () => {
  const events = parseEvents(chatSseToResponsesSse(
    sse({
      id: "chatcmpl_workbuddy_followup",
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
        id: "chatcmpl_workbuddy_followup",
        model: "deepseek-v4.1-flash",
        choices: [{
          delta: { content: "检查完成，目录中只有一个文件。" },
          finish_reason: "stop",
        }],
      }) +
      "data: [DONE]\n\n",
    adapter(true),
  ).text)

  const addedMessages = events
    .filter(
      (event) =>
        event.type === "response.output_item.added" &&
        event.item?.type === "message",
    )
    .map((event) => event.item)
  const doneMessages = events
    .filter(
      (event) =>
        event.type === "response.output_item.done" &&
        event.item?.type === "message",
    )
    .map((event) => event.item)
  const outputMessages = completedMessages(events)

  assert.deepEqual(
    addedMessages.map((item: any) => item.phase),
    [undefined, "final_answer"],
  )
  assert.deepEqual(
    doneMessages.map((item: any) => item.phase),
    ["commentary", "final_answer"],
  )
  assert.deepEqual(
    addedMessages.map((item: any) => item.id),
    doneMessages.map((item: any) => item.id),
  )
  assert.deepEqual(
    outputMessages.map((item: any) => item.id),
    doneMessages.map((item: any) => item.id),
  )
  assert.equal(addedMessages[0].id, `${events.find((event) => event.type === "response.created")?.response.id}_msg`)
  assert.notEqual(addedMessages[0].id, addedMessages[1].id)
  assert.equal(outputMessages[0].content[0].text, "我先检查文件。")
  assert.equal(outputMessages[1].content[0].text, "检查完成，目录中只有一个文件。")
  assert.equal(outputMessages[0].memoryCitation, null)
  assert.equal(outputMessages[1].memoryCitation, null)
})

test("WorkBuddy 后续分片更换 Chat ID 时不改写已创建的响应身份", () => {
  const events = parseEvents(chatSseToResponsesSse(
    sse({
      id: "chatcmpl_workbuddy_first",
      model: "deepseek-v4.1-flash",
      choices: [{ delta: { content: "第一段" } }],
    }) +
      sse({
        id: "chatcmpl_workbuddy_second",
        model: "deepseek-v4.1-flash",
        choices: [{
          delta: { content: "第二段" },
          finish_reason: "stop",
        }],
      }) +
      "data: [DONE]\n\n",
    adapter(true),
  ).text)

  const created = events.find((event) => event.type === "response.created")?.response
  const added = events.find(
    (event) =>
      event.type === "response.output_item.added" &&
      event.item?.type === "message",
  )?.item
  const done = finalMessageEvent(events)
  const completed = events.find((event) => event.type === "response.completed")?.response

  assert.equal(created.id, "resp_chatcmpl_workbuddy_first")
  assert.equal(added.id, `${created.id}_msg`)
  assert.equal(done.id, added.id)
  assert.equal(completed.id, created.id)
})

test("WorkBuddy 增量后到达完整快照时仍保持同一响应与输出索引", () => {
  const events = parseEvents(chatSseToResponsesSse(
    sse({
      id: "chatcmpl_workbuddy_snapshot",
      model: "deepseek-v4.1-flash",
      choices: [{ delta: { content: "正在检查。" } }],
    }) +
      sse({
        id: "chatcmpl_workbuddy_snapshot",
        model: "deepseek-v4.1-flash",
        choices: [{
          message: { role: "assistant", content: "正在检查。" },
          finish_reason: "stop",
        }],
      }) +
      "data: [DONE]\n\n",
    adapter(true),
  ).text)

  const created = events.filter((event) => event.type === "response.created")
  const addedMessages = events.filter(
    (event) => event.type === "response.output_item.added" && event.item?.type === "message",
  )
  const doneMessages = events.filter(
    (event) => event.type === "response.output_item.done" && event.item?.type === "message",
  )
  const completed = events.find((event) => event.type === "response.completed")?.response

  assert.equal(created.length, 1)
  assert.equal(addedMessages.length, 1)
  assert.equal(doneMessages.length, 1)
  assert.equal(addedMessages[0].output_index, 0)
  assert.equal(doneMessages[0].output_index, addedMessages[0].output_index)
  assert.equal(completed.output.filter((item: any) => item.type === "message").length, 1)
  assert.equal(completed.output[0].content[0].text, "正在检查。")
})

test("WorkBuddy 完整快照会把新增后缀继续作为增量发送", () => {
  const events = parseEvents(chatSseToResponsesSse(
    sse({
      id: "chatcmpl_workbuddy_snapshot_suffix",
      model: "deepseek-v4.1-flash",
      choices: [{ delta: { content: "正在检查" } }],
    }) +
      sse({
        id: "chatcmpl_workbuddy_snapshot_suffix",
        model: "deepseek-v4.1-flash",
        choices: [{
          message: { role: "assistant", content: "正在检查文件。" },
          finish_reason: "stop",
        }],
      }) +
      "data: [DONE]\n\n",
    adapter(true),
  ).text)
  const textDeltas = events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta)

  assert.deepEqual(textDeltas, ["正在检查", "文件。"])
  assert.equal(finalMessageEvent(events).content[0].text, "正在检查文件。")
  assert.equal(completedMessage(events).content[0].text, "正在检查文件。")
  assert.equal(
    events.filter((event) => event.type === "response.created").length,
    1,
  )
})

test("WorkBuddy 完整快照不会重复已发送的推理和工具参数", () => {
  const events = parseEvents(chatSseToResponsesSse(
    sse({
      id: "chatcmpl_workbuddy_snapshot_tool",
      model: "deepseek-v4.1-flash",
      choices: [{
        delta: {
          reasoning_content: "先检查",
          tool_calls: [{
            index: 0,
            id: "call_snapshot",
            type: "function",
            function: { name: "exec_command", arguments: '{"cmd":"Get-' },
          }],
        },
      }],
    }) +
      sse({
        id: "chatcmpl_workbuddy_snapshot_tool",
        choices: [{
          message: {
            role: "assistant",
            content: null,
            reasoning_content: "先检查目录",
            tool_calls: [{
              id: "call_snapshot",
              type: "function",
              function: {
                name: "exec_command",
                arguments: '{"cmd":"Get-ChildItem"}',
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }) +
      "data: [DONE]\n\n",
    adapter(true),
  ).text)
  const toolArguments = events
    .filter((event) => event.type === "response.function_call_arguments.delta")
    .map((event) => event.delta)
    .join("")
  const completed = events.find((event) => event.type === "response.completed")?.response
  const toolCall = completed.output.find((item: any) => item.type === "function_call")

  assert.deepEqual(
    events
      .filter((event) => event.type === "response.reasoning_summary_text.delta")
      .map((event) => event.delta),
    ["先检查", "目录"],
  )
  assert.equal(toolArguments, '{"cmd":"Get-ChildItem"}')
  assert.equal(toolCall.arguments, '{"cmd":"Get-ChildItem"}')
  assert.equal(
    events.filter(
      (event) => event.type === "response.output_item.added" && event.item?.type === "function_call",
    ).length,
    1,
  )
  assert.equal(
    events.filter(
      (event) => event.type === "response.output_item.done" && event.item?.type === "function_call",
    ).length,
    1,
  )
})

test("WorkBuddy 完整快照改写文本时保持最终内容一致", () => {
  const events = parseEvents(chatSseToResponsesSse(
    sse({
      id: "chatcmpl_workbuddy_snapshot_replace",
      model: "deepseek-v4.1-flash",
      choices: [{ delta: { content: "旧内容" } }],
    }) +
      sse({
        id: "chatcmpl_workbuddy_snapshot_replace",
        model: "deepseek-v4.1-flash",
        choices: [{
          message: { role: "assistant", content: "新内容" },
          finish_reason: "stop",
        }],
      }) +
      "data: [DONE]\n\n",
    adapter(true),
  ).text)
  const doneText = events
    .filter(
      (event) =>
        event.type === "response.output_item.done" &&
        event.item?.type === "message",
    )
    .at(-1).item.content[0].text
  const completedText = completedMessage(events).content[0].text

  assert.equal(doneText, "新内容")
  assert.equal(completedText, "新内容")
  assert.equal(
    events.some(
      (event) =>
        event.type === "response.output_text.done" &&
        event.text !== completedText,
    ),
    false,
  )
})

test("WorkBuddy 完整快照改写推理时保持最终内容一致", () => {
  const events = parseEvents(chatSseToResponsesSse(
    sse({
      id: "chatcmpl_workbuddy_snapshot_replace_reasoning",
      model: "deepseek-v4.1-flash",
      choices: [{ delta: { reasoning_content: "旧推理" } }],
    }) +
      sse({
        id: "chatcmpl_workbuddy_snapshot_replace_reasoning",
        model: "deepseek-v4.1-flash",
        choices: [{
          message: {
            role: "assistant",
            content: "完成。",
            reasoning_content: "新推理",
          },
          finish_reason: "stop",
        }],
      }) +
      "data: [DONE]\n\n",
    adapter(true),
  ).text)
  const completed = events.find((event) => event.type === "response.completed")?.response
  const reasoning = completed.output.find((item: any) => item.type === "reasoning")
  const reasoningDone = events.find(
    (event) => event.type === "response.reasoning_summary_text.done",
  )

  assert.equal(reasoning.reasoning_content, "新推理")
  assert.equal(reasoningDone.text, "新推理")
})
