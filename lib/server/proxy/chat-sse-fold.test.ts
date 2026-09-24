import assert from "node:assert/strict"
import test from "node:test"

import {
  chatStreamHasUsableOutput,
  chatToolDeltaHasContent,
  chatToolDeltaStartsCall,
  chatToolDeltas,
  foldChatSsePayload,
  parseChatSseFrames,
} from "./chat-sse-fold"

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

test("空工具占位符不算工具边界", () => {
  // WorkBuddy 每帧都带 tool_calls:[] 和 function_call:null，把它们当工具调用
  // 会让推理在第一个 delta 就被收尾，客户端只剩前几个字。
  assert.equal(chatToolDeltaHasContent([]), false)
  assert.equal(chatToolDeltaHasContent(null), false)
  assert.equal(chatToolDeltaHasContent({}), false)
  // 完全没有内容的空壳（连 id 都没有）要丢掉。
  assert.equal(chatToolDeltaHasContent({ function: { name: "", arguments: "" } }), false)
  assert.equal(chatToolDeltaStartsCall({ function: { name: "", arguments: "" } }), false)
  // 工具 JSON 字符串可能把空格单独切成一帧。它不是空占位符，必须进入参数累积；
  // 但纯空格本身也不应提前触发“工具调用开始”的推理收尾边界。
  const whitespaceArgument = { function: { name: "", arguments: " " } }
  assert.equal(chatToolDeltaHasContent(whitespaceArgument), true)
  assert.equal(chatToolDeltaStartsCall(whitespaceArgument), false)
  assert.deepEqual(chatToolDeltas({ tool_calls: [whitespaceArgument] }), [
    { position: 0, value: whitespaceArgument, startsCall: false },
  ])

  const placeholder = {
    tool_calls: [],
    function_call: null,
    reasoning_content: "第一段",
    content: "",
  }
  assert.deepEqual(chatToolDeltas(placeholder), [])

  const real = {
    tool_calls: [
      { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
    ],
  }
  assert.deepEqual(chatToolDeltas(real), [
    { position: 0, value: real.tool_calls[0], startsCall: true },
  ])

  // 单数形态的旧字段统一包成带 index 的形态。
  assert.deepEqual(chatToolDeltas({ function_call: { name: "get_time", arguments: "{}" } }), [
    {
      position: 0,
      value: { index: 0, id: undefined, type: "function", function: { name: "get_time", arguments: "{}" } },
      startsCall: true,
    },
  ])
})

test("只带 id 的开场帧要合并，但不作为推理收尾边界", () => {
  // OpenAI 风格的工具调用可能先发一个只有 id/type 的开场帧，名字和参数随后才到。
  // 这种帧要保留（丢掉的话后面补上名字时没地方挂），但不能拿它当推理边界。
  const opening = { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: {} }] }
  assert.deepEqual(chatToolDeltas(opening), [
    { position: 0, value: opening.tool_calls[0], startsCall: false },
  ])
  assert.equal(chatToolDeltaHasContent(opening.tool_calls[0]), true)
  assert.equal(chatToolDeltaStartsCall(opening.tool_calls[0]), false)

  // 名字到了才算开始调用，这时候才是推理的收尾边界。
  const named = { tool_calls: [{ index: 0, id: "call_abc", function: { name: "get_weather" } }] }
  assert.equal(chatToolDeltaStartsCall(named.tool_calls[0]), true)
})

test("只有 id 的开场帧也把工具调用带进折叠结果", () => {
  // 先给 id，再给名字和参数；如果开场帧被当成空占位符丢掉，这次调用会整个消失。
  const folded = foldChatSsePayload(
    chunk({
      id: "cmb-2",
      model: "hy4-preview",
      choices: [{ index: 0, delta: { reasoning_content: "先看天气", tool_calls: [], content: "" } }],
    }) +
      chunk({
        id: "cmb-2",
        model: "hy4-preview",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_xyz", type: "function", function: {} }] },
        }],
      }) +
      chunk({
        id: "cmb-2",
        model: "hy4-preview",
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { name: "get_weather", arguments: "{\"city\":\"北京\"}" } }] },
          finish_reason: "tool_calls",
        }],
      }) +
      "data: [DONE]\n\n",
  ) as Record<string, any>

  assert.deepEqual(folded.choices[0].message.tool_calls, [
    {
      id: "call_xyz",
      type: "function",
      function: { name: "get_weather", arguments: "{\"city\":\"北京\"}" },
    },
  ])
  assert.equal(folded.choices[0].message.reasoning_content, "先看天气")
})

test("折叠时忽略空工具占位符，只收真工具调用", () => {
  const folded = foldChatSsePayload(
    chunk({
      id: "cmb-1",
      model: "glm-5.3-flash",
      choices: [{
        index: 0,
        delta: { reasoning_content: "先想", tool_calls: [], function_call: null, content: "" },
      }],
    }) +
      chunk({
        id: "cmb-1",
        model: "glm-5.3-flash",
        choices: [{ index: 0, delta: { reasoning_content: "再想", tool_calls: [], content: "好" } }],
      }) +
      chunk({
        id: "cmb-1",
        model: "glm-5.3-flash",
        choices: [{ index: 0, delta: { function_call: { name: "", arguments: "" }, content: "" }, finish_reason: "stop" }],
      }) +
      "data: [DONE]\n\n",
  ) as Record<string, any>
  assert.equal(folded.choices[0].message.reasoning_content, "先想再想")
  assert.equal(folded.choices[0].message.content, "好")
  assert.equal(folded.choices[0].message.tool_calls, undefined)
})

test("折叠时保留推理与正文里的空格", () => {
  // 上游按 token 切片，空格常单独成帧或挂在片头；trim 会把 "Simple question" 粘成
  // "Simplequestion"。非流式折叠同样要原样拼回去。
  const folded = foldChatSsePayload(
    chunk({ choices: [{ index: 0, delta: { reasoning_content: "Simple", content: "" } }] }) +
      chunk({ choices: [{ index: 0, delta: { reasoning_content: " question", content: "Hello" } }] }) +
      chunk({ choices: [{ index: 0, delta: { reasoning_content: ".", content: " world" } }] }) +
      chunk({ choices: [{ index: 0, delta: { content: "。" } }] }) +
      "data: [DONE]\n\n",
  ) as Record<string, any>

  assert.equal(folded.choices[0].message.reasoning_content, "Simple question.")
  assert.equal(folded.choices[0].message.content, "Hello world。")
})

test("折叠时保留工具参数单独成帧的空格", () => {
  const folded = foldChatSsePayload(
    chunk({
      id: "cmb-tool-space",
      model: "deepseek-v4.1-flash",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_space",
            type: "function",
            function: {
              name: "exec_command",
              arguments: "{\"cmd\":\"Start-Sleep -Seconds",
            },
          }],
        },
      }],
    }) +
      chunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "", arguments: " " },
            }],
          },
        }],
      }) +
      chunk({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { name: "", arguments: "30\"}" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      }) +
      "data: [DONE]\n\n",
  ) as Record<string, any>

  assert.equal(
    folded.choices[0].message.tool_calls[0].function.arguments,
    "{\"cmd\":\"Start-Sleep -Seconds 30\"}",
  )
})

test("折叠文本块数组时也保留空格", () => {
  const folded = foldChatSsePayload(
    chunk({ choices: [{ index: 0, delta: { content: [{ type: "text", text: "Hello" }] } }] }) +
      chunk({ choices: [{ index: 0, delta: { content: [{ type: "text", text: " world" }] } }] }) +
      "data: [DONE]\n\n",
  ) as Record<string, any>

  assert.equal(folded.choices[0].message.content, "Hello world")
})

test("额度花在推理上被截断算正常收尾，不算空响应", () => {
  // hy4-preview 这类模型关不掉思考，max_tokens 小的时候推理会吃满额度、
  // 正文一个字都没写出来，上游给 finish_reason=length。这是正常收尾，
  // 报 failed 会让调用方把已经拿到的思考内容整段丢掉。
  assert.equal(
    chatStreamHasUsableOutput({
      hasVisibleMessage: false,
      hasToolCall: false,
      reasoning: "让我想想这个问题……",
      finishReason: "length",
    }),
    true,
  )

  // 正常结束却只有推理、没有正文：这一轮确实没产出可用答案，该报错。
  assert.equal(
    chatStreamHasUsableOutput({
      hasVisibleMessage: false,
      hasToolCall: false,
      reasoning: "让我想想",
      finishReason: "stop",
    }),
    false,
  )

  // 什么都没有，也不是截断：空响应。
  assert.equal(
    chatStreamHasUsableOutput({
      hasVisibleMessage: false,
      hasToolCall: false,
      reasoning: "",
      finishReason: "stop",
    }),
    false,
  )

  // 截断但连推理都没有，同样是空响应。
  assert.equal(
    chatStreamHasUsableOutput({
      hasVisibleMessage: false,
      hasToolCall: false,
      reasoning: "",
      finishReason: "length",
    }),
    false,
  )

  // 有正文或有工具调用就是正常产出，与 finish_reason 无关。
  assert.equal(
    chatStreamHasUsableOutput({
      hasVisibleMessage: true,
      hasToolCall: false,
      reasoning: "",
      finishReason: "stop",
    }),
    true,
  )
  assert.equal(
    chatStreamHasUsableOutput({
      hasVisibleMessage: false,
      hasToolCall: true,
      reasoning: "",
      finishReason: "tool_calls",
    }),
    true,
  )
})
