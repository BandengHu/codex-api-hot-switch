import assert from "node:assert/strict"
import test from "node:test"

import { prepareCodexOpenAICompatibleRequest } from "./codex-protocol"
import {
  normalizeResponsesItemId,
  repairResponsesItemIdsInPayload,
} from "./responses-item-id-repair"
import { parseSseFrames, transformResponsesSseText } from "./responses-sse"

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// 上游 response.failed 会被原样转发给 Codex。Codex 把 error.code / error.type
// 都声明成字符串，数字会让整条 error 反序列化失败、只剩
// "stream disconnected before completion: response.failed event received"，
// 上游的真实原因（例如 WorkBuddy 的频率限制提示）在桌面端完全看不到。
test("forwards upstream response.failed with numeric code normalized to string", () => {
  const message =
    "您的使用量已超出频率限制，将在 2026-09-26 13:10:37 UTC+8 重置，您也可以切换其他模型继续使用。"
  const upstream = sse("response.failed", {
    type: "response.failed",
    response: {
      id: "resp_upstream",
      object: "response",
      status: "failed",
      output: [],
      error: { message, type: "upstream_error", code: 6004 },
    },
  })

  const forwarded = parseSseFrames(
    transformResponsesSseText(upstream, { synthesizeFinalOnStreamEnd: false }).text,
  ).find((frame) => frame.data?.type === "response.failed")

  assert.ok(forwarded, "upstream failure must still be forwarded as response.failed")
  assert.equal(forwarded.data.response.error.message, message)
  assert.equal(forwarded.data.response.error.code, "6004")
  assert.equal(typeof forwarded.data.response.error.code, "string")
})

test("keeps semantic string codes and string error types untouched", () => {
  const upstream = sse("response.failed", {
    type: "response.failed",
    response: {
      id: "resp_upstream",
      status: "failed",
      error: { message: "quota exceeded", type: "rate_limit_error", code: "rate_limit_exceeded" },
    },
  })

  const forwarded = parseSseFrames(
    transformResponsesSseText(upstream, { synthesizeFinalOnStreamEnd: false }).text,
  ).find((frame) => frame.data?.type === "response.failed")

  assert.ok(forwarded)
  assert.equal(forwarded.data.response.error.code, "rate_limit_exceeded")
  assert.equal(forwarded.data.response.error.type, "rate_limit_error")
})

test("normalizes known Responses item types to stable protocol prefixes", () => {
  assert.equal(normalizeResponsesItemId("message", "item_message"), "msg_message")
  assert.equal(normalizeResponsesItemId("reasoning", "item_reasoning"), "rs_reasoning")
  assert.equal(normalizeResponsesItemId("function_call", "item_function"), "fc_function")
  assert.equal(normalizeResponsesItemId("function_call_output", "item_output"), "fco_output")
  assert.equal(normalizeResponsesItemId("custom_tool_call", "item_custom"), "ctc_custom")
  assert.equal(normalizeResponsesItemId("custom_tool_call_output", "item_custom_output"), "ctco_custom_output")
  assert.equal(normalizeResponsesItemId("tool_search_call", "item_search"), "tsc_search")
  assert.equal(normalizeResponsesItemId("tool_search_output", "item_search_output"), "tso_search_output")
  assert.equal(normalizeResponsesItemId("web_search_call", "item_web"), "ws_web")
  assert.equal(normalizeResponsesItemId("function_call", "fc_existing"), "fc_existing")
  assert.equal(normalizeResponsesItemId("unknown", "item_unknown"), undefined)
})

test("repairs outgoing raw Responses history without changing call IDs", () => {
  const prepared = prepareCodexOpenAICompatibleRequest(
    "v1/responses",
    {
      model: "client-model",
      stream: true,
      input: [
        {
          type: "message",
          id: "item_message",
          role: "assistant",
          content: [{ type: "output_text", text: "previous answer" }],
        },
        {
          type: "reasoning",
          id: "item_reasoning",
          summary: [],
        },
        {
          type: "function_call",
          id: "item_function",
          call_id: "call_function_should_stay",
          name: "shell_command",
          arguments: "{}",
        },
        {
          type: "custom_tool_call",
          id: "item_custom",
          call_id: "call_custom_should_stay",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        },
        {
          type: "tool_search_call",
          id: "item_search",
          call_id: "call_search_should_stay",
          arguments: { query: "node_repl js" },
        },
      ],
    },
    "client-model",
    "high",
    { rawResponsesPassthrough: true },
  )

  assert.deepEqual(
    prepared.body.input.map((item: any) => item.id),
    ["msg_message", "rs_reasoning", "fc_function", "ctc_custom", "tsc_search"],
  )
  assert.deepEqual(
    prepared.body.input.map((item: any) => item.call_id).filter(Boolean),
    [
      "call_function_should_stay",
      "call_custom_should_stay",
      "call_search_should_stay",
    ],
  )
  assert.deepEqual(
    prepared.adapter.type === "passthrough"
      ? prepared.adapter.historyRequestBody?.input.map((item: any) => item.id)
      : [],
    ["msg_message", "rs_reasoning", "fc_function", "ctc_custom", "tsc_search"],
  )
})

test("repairs non-stream Responses output item IDs", () => {
  const payload = {
    id: "resp_test",
    output: [
      { type: "message", id: "item_message" },
      { type: "reasoning", id: "item_reasoning" },
      {
        type: "function_call",
        id: "item_function",
        call_id: "call_function",
      },
      {
        type: "custom_tool_call",
        id: "item_custom",
        call_id: "call_custom",
      },
      {
        type: "tool_search_call",
        id: "item_search",
        call_id: "call_search",
      },
    ],
  }

  assert.equal(repairResponsesItemIdsInPayload(payload), true)
  assert.deepEqual(
    payload.output.map((item) => item.id),
    ["msg_message", "rs_reasoning", "fc_function", "ctc_custom", "tsc_search"],
  )
  assert.deepEqual(
    payload.output.map((item) => item.call_id).filter(Boolean),
    ["call_function", "call_custom", "call_search"],
  )
})

test("keeps repaired item IDs consistent across SSE frames", () => {
  const response = {
    id: "resp_stream",
    object: "response",
    status: "completed",
    model: "upstream-model",
    output: [
      { type: "message", id: "item_message", status: "completed", role: "assistant", content: [] },
      { type: "reasoning", id: "item_reasoning", status: "completed", summary: [] },
      {
        type: "function_call",
        id: "item_function",
        status: "completed",
        call_id: "call_function",
        name: "shell_command",
        arguments: "{}",
      },
      {
        type: "custom_tool_call",
        id: "item_custom",
        status: "completed",
        call_id: "call_custom",
        name: "apply_patch",
        input: "",
      },
      {
        type: "tool_search_call",
        id: "item_search",
        status: "completed",
        call_id: "call_search",
        arguments: { query: "node_repl js" },
      },
    ],
  }
  const text = [
    ...response.output.flatMap((item, outputIndex) => [
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress" },
      }),
      sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      }),
    ]),
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: "item_message",
      output_index: 0,
      delta: "hello",
    }),
    sse("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: "item_reasoning",
      output_index: 1,
      delta: "thinking",
    }),
    sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: "item_function",
      output_index: 2,
      delta: "{}",
    }),
    sse("response.custom_tool_call_input.delta", {
      type: "response.custom_tool_call_input.delta",
      item_id: "item_custom",
      output_index: 3,
      delta: "patch",
    }),
    sse("response.tool_search_call.done", {
      type: "response.tool_search_call.done",
      item_id: "item_search",
      output_index: 4,
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
  const completed = frames.find((frame) => frame.data.type === "response.completed")
  assert.ok(completed)
  assert.deepEqual(
    completed.data.response.output.map((item: any) => item.id),
    ["msg_message", "rs_reasoning", "fc_function", "ctc_custom", "tsc_search"],
  )

  const expectedByEvent = new Map([
    ["response.output_text.delta", "msg_message"],
    ["response.reasoning_summary_text.delta", "rs_reasoning"],
    ["response.function_call_arguments.delta", "fc_function"],
    ["response.custom_tool_call_input.delta", "ctc_custom"],
    ["response.tool_search_call.done", "tsc_search"],
  ])
  for (const frame of frames) {
    const expected = expectedByEvent.get(frame.data.type)
    if (expected) assert.equal(frame.data.item_id, expected)
  }
})
