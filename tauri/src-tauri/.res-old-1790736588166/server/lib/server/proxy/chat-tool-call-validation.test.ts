import assert from "node:assert/strict"
import test from "node:test"

import { chatCompletionToResponse } from "./chat-compatible"

const toolContext = {
  customTools: {},
  functionTools: {},
  toolSearchTools: [],
  webSearchTools: [],
}

function convert(message: any, finishReason: string) {
  return chatCompletionToResponse(
    {
      id: "chatcmpl_validation",
      model: "kimi-k3",
      choices: [{
        message: { role: "assistant", ...message },
        finish_reason: finishReason,
      }],
    },
    { model: "kimi-k3" },
    toolContext,
  )
}

test("非流式仅有无名称工具调用时拒绝伪成功", () => {
  assert.throws(
    () =>
      convert(
        {
          content: "让我继续处理这个文件",
          tool_calls: [{
            id: "call_bad",
            type: "function",
            function: { arguments: "{}" },
          }],
        },
        "tool_calls",
      ),
    /without a function name/,
  )
})

test("非流式混合调用保留合法工具调用", () => {
  const response = convert(
    {
      tool_calls: [
        {
          id: "call_bad",
          type: "function",
          function: { name: "   ", arguments: "{}" },
        },
        {
          id: "call_good",
          type: "function",
          function: { name: "exec_command", arguments: '{"cmd":"ls"}' },
        },
      ],
    },
    "tool_calls",
  )

  assert.equal(response.status, "completed")
  assert.equal(response.output.length, 1)
  assert.equal(response.output[0].call_id, "call_good")
  assert.equal(response.output[0].name, "exec_command")
})

test("非流式截断调用保持 incomplete 而不是工具错误", () => {
  const response = convert(
    {
      content: "我来看看",
      tool_calls: [{
        id: "call_cut",
        type: "function",
        function: { arguments: '{"pa' },
      }],
    },
    "length",
  )

  assert.equal(response.status, "incomplete")
  assert.equal(response.incomplete_details.reason, "max_output_tokens")
})

test("非流式 completed 工具调用拒绝畸形或非对象 arguments", () => {
  for (const argumentsValue of ['{"path":', "[1,2]"]) {
    assert.throws(
      () =>
        convert(
          {
            tool_calls: [{
              id: "call_bad_args",
              type: "function",
              function: {
                name: "exec_command",
                arguments: argumentsValue,
              },
            }],
          },
          "tool_calls",
        ),
      /arguments (?:不是合法 JSON|必须是 JSON 对象)/,
    )
  }
})

test("非流式 incomplete 工具调用把畸形 arguments 归一为空对象", () => {
  const response = convert(
    {
      tool_calls: [{
        id: "call_partial",
        type: "function",
        function: {
          name: "exec_command",
          arguments: '{"cmd":',
        },
      }],
    },
    "length",
  )

  assert.equal(response.status, "incomplete")
  assert.equal(response.output[0].arguments, "{}")
})
