import assert from "node:assert/strict"
import test from "node:test"

import { buildResponsesBodyFromChatCompletions } from "./codex-protocol"

function convert(field: string, value: unknown) {
  const converted = buildResponsesBodyFromChatCompletions({
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: "ping" }],
    [field]: value,
  })
  return converted.body.max_output_tokens
}

test("Chat 转 Responses 时把 1 至 15 的输出预算抬到 16", () => {
  for (const field of [
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
  ]) {
    for (const value of [1, 8, 15]) {
      assert.equal(convert(field, value), 16, `${field}=${value}`)
    }
  }
})

test("合法或非整数输出预算保持原值", () => {
  for (const value of [0, 16, 1024, 12.5, "16"]) {
    assert.equal(convert("max_tokens", value), value)
  }
})
