import assert from "node:assert/strict"
import test from "node:test"

import {
  createDeepSeekResponsesReasoningStream,
  isDeepSeekResponsesThinkingTarget,
  normalizeDeepSeekResponsesPayload,
  normalizeDeepSeekResponsesSseText,
} from "./deepseek-responses-reasoning"
import {
  createResponsesSseRepairStream,
  extractFinalResponseFromSse,
} from "./responses-sse"

function sse(event: string, payload: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

function parseFrames(text: string) {
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map((frame) => frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n"))
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data))
}

const deepSeekTarget = {
  provider: {
    protocol: "openai-responses",
    rawResponsesPassthrough: false,
    name: "阿里百炼 Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
  },
  modelId: "deepseek-v4.1-flash",
  requestedModel: "switchgate__deepseek",
} as any

async function throughStream(text: string, target = deepSeekTarget, splitEveryByte = false) {
  const bytes = new TextEncoder().encode(text)
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitEveryByte) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      } else {
        controller.enqueue(bytes)
      }
      controller.close()
    },
  })
  return new Response(source.pipeThrough(createDeepSeekResponsesReasoningStream(target))).text()
}

test("matches all DeepSeek model families independently of provider or client slug", () => {
  for (const modelId of [
    "deepseek-chat", "deepseek-reasoner", "deepseek-r1", "deepseek-v3.2",
    "deepseek-v4-pro", "deepseek-v4.1-flash", "vendor/DeepSeek-R1", "DeepSeek-V5",
  ]) {
    assert.equal(isDeepSeekResponsesThinkingTarget({
      ...deepSeekTarget, modelId, requestedModel: "switchgate__auto",
    }), true, modelId)
  }
  assert.equal(isDeepSeekResponsesThinkingTarget({
    ...deepSeekTarget,
    modelId: "endpoint-opaque-id",
    model: { reasoningDialect: "deepseek-official" },
  }), true)
})

test("does not infer the active model from provider names or stale client slugs", () => {
  const target = {
    ...deepSeekTarget,
    modelId: "qwen3.7-plus",
    requestedModel: "switchgate__deepseek",
    provider: { ...deepSeekTarget.provider, name: "DeepSeek", baseUrl: "https://deepseek.example/v1" },
  }
  assert.equal(isDeepSeekResponsesThinkingTarget(target), false)
  for (const protocol of ["openai-chat", "anthropic", "gemini"]) {
    assert.equal(isDeepSeekResponsesThinkingTarget({
      ...deepSeekTarget, provider: { ...deepSeekTarget.provider, protocol },
    }), false)
  }
})

test("normalizes DeepSeek Responses reasoning events for Codex", () => {
  const input = [
    sse("response.reasoning_text.delta", {
      type: "response.reasoning_text.delta",
      item_id: "rs_1",
      output_index: 0,
      content_index: 0,
      sequence_number: 3,
      delta: "先检查输入。",
    }),
    sse("response.reasoning_text.done", {
      type: "response.reasoning_text.done",
      item_id: "rs_1",
      output_index: 0,
      content_index: 0,
      text: "先检查输入。",
    }),
    sse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 1,
      content_index: 0,
      delta: "完成。",
    }),
  ].join("")

  const frames = parseFrames(normalizeDeepSeekResponsesSseText(input, deepSeekTarget))
  assert.equal(frames[0].type, "response.reasoning_summary_text.delta")
  assert.equal(frames[0].summary_index, 0)
  assert.equal(frames[0].content_index, undefined)
  assert.equal(frames[0].sequence_number, 3)
  assert.equal(frames[0].item_id, "rs_1")
  assert.equal(frames[0].output_index, 0)
  assert.equal(frames[0].delta, "先检查输入。")
  assert.equal(frames[1].type, "response.reasoning_summary_text.done")
  assert.equal(frames[2].type, "response.output_text.delta")
  assert.equal(frames[2].delta, "完成。")
})

test("projects reasoning output to summary without changing content, signatures or tool calls", () => {
  const payload = {
    id: "resp_1",
    output: [
      {
        id: "rs_1",
        type: "reasoning",
        content: [{ type: "reasoning_text", text: "需要读取文件。" }],
        summary: [],
        encrypted_content: "opaque-upstream-signature",
      },
      {
        id: "fc_1",
        type: "function_call",
        name: "apply_patch",
        arguments: "{}",
      },
    ],
  }

  normalizeDeepSeekResponsesPayload(payload, deepSeekTarget)
  const reasoning = payload.output[0] as any
  const toolCall = payload.output[1] as any
  assert.deepEqual(reasoning.summary, [
    { type: "summary_text", text: "需要读取文件。" },
  ])
  assert.equal(reasoning.content[0].type, "reasoning_text")
  assert.equal(reasoning.encrypted_content, "opaque-upstream-signature")
  assert.equal(toolCall.type, "function_call")
  assert.equal(toolCall.arguments, "{}")
})

test("fills missing or empty summaries but preserves an existing native summary", () => {
  for (const summary of [undefined, [], [{ type: "summary_text", text: "" }]]) {
    const reasoning: any = {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "第一段" }, { type: "reasoning_text", text: "第二段" }],
      summary,
    }
    normalizeDeepSeekResponsesPayload({ output: [reasoning] }, deepSeekTarget)
    assert.deepEqual(reasoning.summary, [
      { type: "summary_text", text: "第一段" }, { type: "summary_text", text: "第二段" },
    ])
    const once = structuredClone(reasoning)
    normalizeDeepSeekResponsesPayload({ output: [reasoning] }, deepSeekTarget)
    assert.deepEqual(reasoning, once)
  }
  const native = {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "已有摘要" }],
    content: [{ type: "reasoning_text", text: "原始内容" }],
  }
  const original = structuredClone(native)
  normalizeDeepSeekResponsesPayload({ output: [native] }, deepSeekTarget)
  assert.deepEqual(native, original)
})

test("supports reasoning_content and wrapped response payloads without inventing text", () => {
  const item = { type: "reasoning", reasoning_content: "上游返回的内容" } as any
  normalizeDeepSeekResponsesPayload({ response: { output: [item] } }, deepSeekTarget)
  assert.deepEqual(item.summary, [{ type: "summary_text", text: "上游返回的内容" }])
  const empty = { type: "reasoning", summary: [], encrypted_content: "opaque" }
  const original = structuredClone(empty)
  normalizeDeepSeekResponsesPayload({ output: [empty] }, deepSeekTarget)
  assert.deepEqual(empty, original)
})

test("maps reasoning part lifecycle and indices without changing message content parts", () => {
  for (const suffix of ["added", "done"]) {
    for (const event of [`response.content_part.${suffix}`, `response.reasoning_text.part.${suffix}`]) {
      const input = sse(event, {
        type: event, item_id: "rs_1", output_index: 2, content_index: 1,
        part: { type: "reasoning_text", text: suffix === "done" ? "第二段" : "" },
      })
      const [frame] = parseFrames(normalizeDeepSeekResponsesSseText(input, deepSeekTarget))
      assert.equal(frame.type, `response.reasoning_summary_part.${suffix}`)
      assert.equal(frame.summary_index, 1)
      assert.equal(frame.output_index, 2)
      assert.equal(frame.part.type, "summary_text")
      assert.equal(frame.content_index, undefined)
    }
    const normal = sse(`response.content_part.${suffix}`, {
      type: `response.content_part.${suffix}`, part: { type: "output_text", text: "正文" },
    })
    assert.equal(normalizeDeepSeekResponsesSseText(normal, deepSeekTarget), normal)
  }
})

test("retains native summary events exactly and handles events without data.type", () => {
  const native = sse("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta", summary_index: 2, delta: "已有摘要",
  })
  assert.equal(normalizeDeepSeekResponsesSseText(native, deepSeekTarget), native)
  const input = sse("response.reasoning_text.delta", { delta: "思考" })
  const [frame] = parseFrames(normalizeDeepSeekResponsesSseText(input, deepSeekTarget))
  assert.equal(frame.type, "response.reasoning_summary_text.delta")
  assert.equal(frame.summary_index, 0)
})

test("does not normalize raw Responses passthrough in JSON, buffered SSE or byte streams", async () => {
  const rawTarget = {
    ...deepSeekTarget,
    provider: {
      ...deepSeekTarget.provider,
      rawResponsesPassthrough: true,
    },
  }
  const input = ": keepalive\r\n\r\n" + sse("response.reasoning_text.delta", {
    type: "response.reasoning_text.delta",
    delta: "原样",
  }).replaceAll("\n", "\r\n") + "data: [DONE]\r\n\r\n"
  assert.equal(normalizeDeepSeekResponsesSseText(input, rawTarget), input)
  assert.equal(await throughStream(input, rawTarget, true), input)
  const rawPayload = { output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "原样" }] }] }
  const original = structuredClone(rawPayload)
  assert.equal(normalizeDeepSeekResponsesPayload(rawPayload, rawTarget), rawPayload)
  assert.deepEqual(rawPayload, original)
})

test("does not alter other models even when their events also use reasoning_text", async () => {
  const target = { ...deepSeekTarget, modelId: "gpt-5.4" }
  const input = sse("response.reasoning_text.delta", { type: "response.reasoning_text.delta", delta: "unchanged" })
  assert.equal(normalizeDeepSeekResponsesSseText(input, target), input)
  assert.equal(await throughStream(input, target, true), input)
  const payload = { output: [{ type: "reasoning", reasoning_content: "unchanged" }] }
  const original = structuredClone(payload)
  normalizeDeepSeekResponsesPayload(payload, target)
  assert.deepEqual(payload, original)
})

test("handles UTF-8 split across chunks and preserves SSE metadata, separators and usage", async () => {
  const input = [
    ": keepalive\r\n\r\n",
    'id: 17\r\nretry: 1000\r\nevent: response.reasoning_text.delta\r\n: metadata\r\ndata: {"type":"response.reasoning_text.delta",\r\ndata: "content_index":0,"delta":"中文🙂"}\r\n\r\n',
    sse("response.output_text.delta", { type: "response.output_text.delta", delta: "正文" }),
    sse("response.completed", {
      type: "response.completed",
      response: { status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 25 } },
    }),
    "data: [DONE]\r\n\r\n",
    ": final comment without separator",
  ].join("")
  const output = await throughStream(input, deepSeekTarget, true)
  assert.equal(output, normalizeDeepSeekResponsesSseText(input, deepSeekTarget))
  assert.ok(output.includes("id: 17\r\nretry: 1000\r\n"))
  assert.ok(output.includes(": metadata\r\n"))
  assert.ok(output.includes('event: response.reasoning_summary_text.delta\r\n'))
  assert.ok(output.includes('"delta":"中文🙂"'))
  assert.ok(output.includes(input.slice(input.indexOf("event: response.output_text.delta"))))
})

test("preserves malformed frames and failed terminals instead of masking an upstream error", async () => {
  const input = ": ping\n\ndata: not-json\n\ndata: null\n\n" + sse("response.failed", {
    type: "response.failed",
    response: { status: "failed", error: { code: "upstream_error", message: "failure" } },
  })
  assert.equal(normalizeDeepSeekResponsesSseText(input, deepSeekTarget), input)
  assert.equal(await throughStream(input, deepSeekTarget, true), input)
})

test("keeps reasoning, tool calls, terminal output and tokens through the existing SSE repair chain", async () => {
  const reasoning = {
    id: "rs_1", type: "reasoning", summary: [],
    content: [{ type: "reasoning_text", text: "先调用工具。" }],
  }
  const tool = {
    id: "fc_1", type: "function_call", call_id: "call_1", name: "read_file",
    arguments: '{"path":"文件.txt"}', status: "completed",
  }
  const usage = { input_tokens: 100, output_tokens: 25, total_tokens: 125 }
  const input = [
    sse("response.created", {
      type: "response.created",
      response: { id: "resp_1", object: "response", status: "in_progress", model: "deepseek-v4.1-flash", output: [] },
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added", output_index: 0, item: { ...reasoning, content: [] },
    }),
    sse("response.reasoning_text.delta", {
      type: "response.reasoning_text.delta", item_id: "rs_1", output_index: 0, content_index: 0, delta: "先调用工具。",
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done", output_index: 0, item: reasoning,
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added", output_index: 1, item: { ...tool, status: "in_progress", arguments: "" },
    }),
    sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_1", delta: tool.arguments,
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done", output_index: 1, item: tool,
    }),
    sse("response.completed", {
      type: "response.completed",
      response: { id: "resp_1", object: "response", status: "completed", output: [reasoning, tool], usage },
    }),
  ].join("")
  const output = await new Response(new Response(input).body!
    .pipeThrough(createDeepSeekResponsesReasoningStream(deepSeekTarget))
    .pipeThrough(createResponsesSseRepairStream({ synthesizeFinalOnStreamEnd: true }))).text()
  const frames = parseFrames(output)
  assert.equal(frames.filter((frame) => frame.type === "response.reasoning_summary_text.delta").length, 1)
  assert.equal(frames.filter((frame) => frame.type === "response.reasoning_text.delta").length, 0)
  assert.equal(frames.filter((frame) => frame.type === "response.completed").length, 1)
  const { final } = extractFinalResponseFromSse(output)
  assert.deepEqual(final.usage, usage)
  assert.deepEqual(final.output.find((item: any) => item.type === "function_call"), tool)
  const finalReasoning = final.output.find((item: any) => item.type === "reasoning")
  assert.deepEqual(finalReasoning.content, reasoning.content)
  assert.deepEqual(finalReasoning.summary, [{ type: "summary_text", text: "先调用工具。" }])
})
