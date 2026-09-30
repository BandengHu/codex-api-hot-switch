import assert from "node:assert/strict"
import test from "node:test"

import { chatWireToolChoice } from "./chat-tool-choice"

const tools = [
  { type: "function", function: { name: "exec_command" } },
  { type: "function", function: { name: "apply_patch" } },
]

test("字符串形态原样保留", () => {
  for (const choice of ["auto", "none", "required"]) {
    assert.equal(chatWireToolChoice(choice, tools), choice)
  }
})

test("对象形态降级成裸工具名", () => {
  assert.equal(
    chatWireToolChoice({ type: "function", name: "exec_command" }, tools),
    "exec_command",
  )
  assert.equal(
    chatWireToolChoice({ type: "function", function: { name: "apply_patch" } }, tools),
    "apply_patch",
  )
})

test("三态对象也收成字符串，不漏对象出去", () => {
  assert.equal(chatWireToolChoice({ type: "auto" }, tools), "auto")
  assert.equal(chatWireToolChoice({ type: "none" }, tools), "none")
  assert.equal(chatWireToolChoice({ type: "required" }, tools), "required")
})

test("名字不在本次 tools 里就整个丢掉", () => {
  assert.equal(chatWireToolChoice({ type: "function", name: "not_sent" }, tools), undefined)
})

test("认不出来的形态一律丢掉，不把对象透给上游", () => {
  assert.equal(chatWireToolChoice({ type: "tool_search" }, tools), undefined)
  assert.equal(chatWireToolChoice({ type: "custom", name: "apply_patch" }, tools), undefined)
  assert.equal(chatWireToolChoice({ type: "function" }, tools), undefined)
  assert.equal(chatWireToolChoice(undefined, tools), undefined)
  assert.equal(chatWireToolChoice(null, tools), undefined)
  assert.equal(chatWireToolChoice(42, tools), undefined)
})

test("没有任何 tool_choice 时返回 undefined", () => {
  assert.equal(chatWireToolChoice(undefined, []), undefined)
})
