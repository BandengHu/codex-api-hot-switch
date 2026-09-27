import assert from "node:assert/strict"
import test from "node:test"

import { chatSseToResponsesSse, type ChatCompatibleAdapter } from "./chat-compatible"

function sse(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function adapter(): Extract<ChatCompatibleAdapter, { type: "chat_compatible" }> {
  return {
    type: "chat_compatible",
    source: "responses",
    requestIsStream: true,
    originalRequest: { model: "deepseek-v4-pro", stream: true },
    toolContext: {
      customTools: {},
      functionTools: {},
      toolSearchTools: [],
      webSearchTools: [],
    },
  }
}

function eventsFrom(text: string) {
  return chatSseToResponsesSse(text, adapter())
    .text
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

function completedResponse(events: any[]) {
  return events.find((event) => event.type === "response.completed")?.response
}

test("空 ID 续块不会覆盖已有工具调用身份", () => {
  const events = eventsFrom(
    sse({
      id: "chatcmpl_dashscope",
      model: "deepseek-v4-pro",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_dashscope",
            type: "function",
            function: { name: "exec_command", arguments: "{" },
          }],
        },
      }],
    }) +
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "",
              type: "function",
              function: { name: "", arguments: '"cmd":"date"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }) +
      "data: [DONE]\n\n",
  )

  const output = completedResponse(events).output
  assert.equal(output.length, 1)
  assert.equal(output[0].call_id, "call_dashscope")
  assert.equal(output[0].name, "exec_command")
  assert.equal(output[0].arguments, '{"cmd":"date"}')
})

test("并行工具名称晚到时按 Chat index 释放", () => {
  const events = eventsFrom(
    sse({
      id: "chatcmpl_parallel",
      model: "deepseek-v4-pro",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_first",
            type: "function",
            function: { name: "", arguments: "{" },
          }],
        },
      }],
    }) +
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 1,
              id: "call_second",
              type: "function",
              function: { name: "second_tool", arguments: '{"value":2}' },
            }],
          },
        }],
      }) +
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "first_tool", arguments: '"value":1}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }) +
      "data: [DONE]\n\n",
  )

  const added = events.filter((event) => event.type === "response.output_item.added")
  assert.deepEqual(
    added.map((event) => event.item.name),
    ["first_tool", "second_tool"],
  )
  assert.deepEqual(
    completedResponse(events).output.map((item: any) => item.name),
    ["first_tool", "second_tool"],
  )
})

test("前一条调用缺名时仍保留后面的有效调用", () => {
  const events = eventsFrom(
    sse({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_missing",
            type: "function",
            function: { arguments: "{}" },
          }],
        },
      }],
    }) +
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 1,
              id: "call_valid",
              type: "function",
              function: { name: "exec_command", arguments: '{"cmd":"date"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }) +
      "data: [DONE]\n\n",
  )

  const output = completedResponse(events).output
  assert.equal(output.length, 1)
  assert.equal(output[0].call_id, "call_valid")
  assert.equal(output[0].name, "exec_command")
})

test("收尾保留非连续工具 index", () => {
  const events = eventsFrom(
    sse({
      choices: [{
        delta: {
          tool_calls: [{
            index: 2,
            id: "call_sparse",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"README.md"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }) +
      "data: [DONE]\n\n",
  )

  const output = completedResponse(events).output
  assert.equal(output.length, 1)
  assert.equal(output[0].call_id, "call_sparse")
  assert.equal(output[0].name, "read_file")
  assert.equal(output[0].arguments, '{"path":"README.md"}')
})

test("缺失 index 的不同调用 ID 不会坍缩", () => {
  const events = eventsFrom(
    sse({
      choices: [{
        delta: {
          tool_calls: [{
            id: "call_a",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.txt"}' },
          }],
        },
      }],
    }) +
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              id: "call_b",
              type: "function",
              function: { name: "exec_command", arguments: '{"cmd":"ls"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }) +
      "data: [DONE]\n\n",
  )

  const output = completedResponse(events).output
  assert.deepEqual(
    output.map((item: any) => [item.call_id, item.name]),
    [
      ["call_a", "read_file"],
      ["call_b", "exec_command"],
    ],
  )
})

test("缺失 index 和 ID 的参数续块归入最后一个调用", () => {
  const events = eventsFrom(
    sse({
      choices: [{
        delta: {
          tool_calls: [{
            id: "call_a",
            type: "function",
            function: { name: "read_file", arguments: '{"path":' },
          }],
        },
      }],
    }) +
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              type: "function",
              function: { arguments: '"a.txt"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }) +
      "data: [DONE]\n\n",
  )

  const output = completedResponse(events).output
  assert.equal(output.length, 1)
  assert.equal(output[0].call_id, "call_a")
  assert.equal(output[0].arguments, '{"path":"a.txt"}')
})

test("只有无名称工具调用时流式响应明确失败", () => {
  const events = eventsFrom(
    sse({
      choices: [{
        delta: { content: "让我继续处理这个文件" },
      }],
    }) +
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_bad",
              type: "function",
              function: { arguments: "{}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }) +
      "data: [DONE]\n\n",
  )

  const failed = events.find((event) => event.type === "response.failed")
  assert.equal(failed.response.error.type, "upstream_tool_call_dropped")
  assert.match(failed.response.error.message, /without a function name/)
  assert.equal(events.some((event) => event.type === "response.completed"), false)
})

test("被截断的无名称工具调用仍保持 incomplete", () => {
  const events = eventsFrom(
    sse({
      choices: [{
        delta: { content: "我来看看" },
      }],
    }) +
      sse({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_cut",
              type: "function",
              function: { arguments: '{"pa' },
            }],
          },
          finish_reason: "length",
        }],
      }) +
      "data: [DONE]\n\n",
  )

  const completed = completedResponse(events)
  assert.equal(completed.status, "incomplete")
  assert.equal(completed.incomplete_details.reason, "max_output_tokens")
  assert.equal(events.some((event) => event.type === "response.failed"), false)
})

test("completed 流式工具调用的畸形 arguments 明确失败", () => {
  const events = eventsFrom(
    sse({
      id: "chatcmpl_bad_args",
      model: "deepseek-v4-pro",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_bad_args",
            type: "function",
            function: {
              name: "exec_command",
              arguments: '{"cmd":',
            },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }) +
      "data: [DONE]\n\n",
  )

  const failed = events.find((event) => event.type === "response.failed")
  assert.ok(failed)
  assert.equal(failed.response.error.type, "upstream_tool_arguments_invalid")
  assert.match(failed.response.error.message, /arguments 不是合法 JSON/)
  assert.equal(completedResponse(events), undefined)
})

test("incomplete 流式工具调用把畸形 arguments 归一为空对象", () => {
  const events = eventsFrom(
    sse({
      id: "chatcmpl_partial_args",
      model: "deepseek-v4-pro",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_partial_args",
            type: "function",
            function: {
              name: "exec_command",
              arguments: '{"cmd":',
            },
          }],
        },
        finish_reason: "length",
      }],
    }) +
      "data: [DONE]\n\n",
  )

  const response = completedResponse(events)
  assert.equal(response.status, "incomplete")
  assert.equal(response.output[0].arguments, "{}")
})
