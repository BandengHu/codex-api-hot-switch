import assert from "node:assert/strict"
import test from "node:test"

import { prepareCodexOpenAICompatibleRequest } from "./codex-protocol"
import {
  normalizeResponsesMessageId,
  repairResponsesMessageIdsInPayload,
} from "./responses-message-id-repair"
import { parseSseFrames, transformResponsesSseText } from "./responses-sse"

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

test("normalizes upstream message IDs to stable msg IDs", () => {
  assert.equal(normalizeResponsesMessageId("item_b960"), "msg_b960")
  assert.equal(normalizeResponsesMessageId("resp_old_msg"), "msg_resp_old_msg")
  assert.equal(normalizeResponsesMessageId("msg_existing"), "msg_existing")
  assert.equal(normalizeResponsesMessageId(""), undefined)
})

test("repairs outgoing Responses message history without touching tool IDs", () => {
  const prepared = prepareCodexOpenAICompatibleRequest(
    "v1/responses",
    {
      model: "client-model",
      stream: true,
      input: [
        {
          type: "message",
          id: "item_b960011c3121c2920d0dbf2b",
          role: "assistant",
          content: [{ type: "output_text", text: "previous answer" }],
        },
        {
          type: "reasoning",
          id: "item_reasoning_should_stay",
          summary: [],
        },
        {
          type: "function_call",
          id: "item_function_should_stay",
          call_id: "call_function_should_stay",
          name: "shell_command",
          arguments: "{}",
        },
      ],
    },
    "client-model",
    "high",
    { rawResponsesPassthrough: true },
  )

  assert.equal(prepared.body.input[0].id, "msg_b960011c3121c2920d0dbf2b")
  assert.equal(prepared.body.input[1].id, "item_reasoning_should_stay")
  assert.equal(prepared.body.input[2].id, "item_function_should_stay")
  assert.equal(prepared.body.input[2].call_id, "call_function_should_stay")
  assert.equal(
    prepared.adapter.type === "passthrough"
      ? prepared.adapter.historyRequestBody?.input[0].id
      : undefined,
    "msg_b960011c3121c2920d0dbf2b",
  )
})

test("repairs non-stream Responses output message IDs", () => {
  const payload = {
    id: "resp_test",
    output: [
      {
        type: "message",
        id: "item_message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
      {
        type: "function_call",
        id: "item_function",
        call_id: "call_function",
        name: "shell_command",
        arguments: "{}",
      },
    ],
  }

  assert.equal(repairResponsesMessageIdsInPayload(payload), true)
  assert.equal(payload.output[0].id, "msg_message")
  assert.equal(payload.output[1].id, "item_function")
  assert.equal(payload.output[1].call_id, "call_function")
})

test("keeps one repaired message ID across all related SSE frames", () => {
  const upstreamMessageId = "item_message_stream"
  const upstreamFunctionId = "item_function_stream"
  const response = {
    id: "resp_stream",
    object: "response",
    status: "completed",
    model: "upstream-model",
    output: [
      {
        type: "message",
        id: upstreamMessageId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      },
      {
        type: "function_call",
        id: upstreamFunctionId,
        call_id: "call_function_stream",
        name: "shell_command",
        arguments: "{}",
      },
    ],
  }
  const text = [
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: upstreamMessageId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    }),
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: upstreamMessageId,
      output_index: 0,
      delta: "hello",
    }),
    sse("response.output_text.done", {
      type: "response.output_text.done",
      item_id: upstreamMessageId,
      output_index: 0,
      text: "hello",
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: response.output[0],
    }),
    sse("response.completed", {
      type: "response.completed",
      response,
    }),
    "data: [DONE]\n\n",
  ].join("")

  const repaired = transformResponsesSseText(text, {
    synthesizeFinalOnStreamEnd: false,
  }).text
  const frames = parseSseFrames(repaired).filter((frame) => frame.data)
  const messageIds = frames
    .flatMap((frame) => {
      const data = frame.data
      if (data.type === "response.output_item.added" || data.type === "response.output_item.done") {
        return [data.item?.id]
      }
      if (
        data.type === "response.output_text.delta" ||
        data.type === "response.output_text.done"
      ) {
        return [data.item_id]
      }
      if (data.type === "response.completed") {
        return data.response.output
          .filter((item: any) => item.type === "message")
          .map((item: any) => item.id)
      }
      return []
    })
    .filter(Boolean)

  assert.deepEqual(new Set(messageIds), new Set(["msg_message_stream"]))
  const completed = frames.find((frame) => frame.data.type === "response.completed")
  assert.ok(completed)
  assert.equal(
    completed.data.response.output.find((item: any) => item.type === "function_call").id,
    upstreamFunctionId,
  )
  assert.equal(
    completed.data.response.output.find((item: any) => item.type === "function_call").call_id,
    "call_function_stream",
  )
})
