import assert from "node:assert/strict"
import test from "node:test"

import { prepareCodexOpenAICompatibleRequest } from "./codex-protocol"

function historyInput(prepared: ReturnType<typeof prepareCodexOpenAICompatibleRequest>) {
  const adapter = prepared.adapter
  if (adapter.type !== "passthrough" || !adapter.historyRequestBody) {
    throw new Error("expected passthrough adapter with history body")
  }
  return adapter.historyRequestBody.input as Array<Record<string, any>>
}

test("raw 透传时把 web_search_call 历史转成配对的 function_call", () => {
  const body = {
    model: "upstream-model",
    stream: false,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "查一下" }] },
      {
        type: "web_search_call",
        id: "ws_aaaa",
        status: "completed",
        action: { type: "search", query: "current date", queries: ["current date"] },
      },
      {
        type: "web_search_call",
        id: "ws_bbbb",
        status: "completed",
        action: { type: "open_page", url: "https://example.com/a" },
      },
    ],
  }

  const prepared = prepareCodexOpenAICompatibleRequest(
    "v1/responses",
    body,
    "upstream-model",
    "high",
    { rawResponsesPassthrough: true },
  )
  const input = (prepared.body as Record<string, any>).input as Array<Record<string, any>>

  assert.equal(input.some((item) => item.type === "web_search_call"), false)
  const calls = input.filter((item) => item.type === "function_call")
  const outputs = input.filter((item) => item.type === "function_call_output")
  assert.equal(calls.length, 2)
  assert.equal(outputs.length, 2)
  assert.equal(calls[0].name, "web_search")
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    query: "current date",
    queries: ["current date"],
  })
  assert.deepEqual(JSON.parse(calls[1].arguments), { url: "https://example.com/a" })
  for (let index = 0; index < calls.length; index += 1) {
    assert.equal(calls[index].call_id, outputs[index].call_id)
  }

  const history = historyInput(prepared)
  assert.equal(history.some((item) => item.type === "web_search_call"), false)
  assert.equal(history.filter((item) => item.type === "function_call").length, 2)

  // 原始请求体保持不变
  assert.equal(body.input[1].type, "web_search_call")
})
