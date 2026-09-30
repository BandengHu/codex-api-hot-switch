import assert from "node:assert/strict"
import test from "node:test"

import {
  cleanupOrphanToolCalls,
  normalizeChatToolPairing,
  repackToolResultBlocks,
} from "./chat-tool-pairing"

const user = (text: string) => ({ role: "user", content: text })
const assistantCalling = (...ids: string[]) => ({
  role: "assistant",
  content: "",
  tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "exec_command", arguments: "{}" } })),
})
const toolResult = (id: string) => ({ role: "tool", tool_call_id: id, content: `结果 ${id}` })

test("没有工具流量时原样返回同一个数组", () => {
  const messages = [user("你好"), { role: "assistant", content: "在的" }]
  assert.equal(repackToolResultBlocks(messages), messages)
  assert.equal(cleanupOrphanToolCalls(messages), messages)
  assert.equal(normalizeChatToolPairing(messages), messages)
})

test("结果之间插入的消息被挪到整组之后", () => {
  const messages = [
    user("并行跑两条"),
    assistantCalling("c00", "c01"),
    toolResult("c00"),
    user("<image_resize_notice>图片已缩放</image_resize_notice>"),
    toolResult("c01"),
  ]
  const out = repackToolResultBlocks(messages)
  assert.deepEqual(
    out.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "user"],
  )
  assert.deepEqual(
    out.slice(2, 4).map((message) => message.tool_call_id),
    ["c00", "c01"],
  )
})

test("两个连续的调用组都能各自把结果收拢", () => {
  const messages = [
    assistantCalling("a1"),
    toolResult("a1"),
    user("插一句"),
    assistantCalling("b1", "b2"),
    toolResult("b1"),
    user("再插一句"),
    toolResult("b2"),
  ]
  const out = repackToolResultBlocks(messages)
  assert.deepEqual(
    out.map((message) => message.role),
    ["assistant", "tool", "user", "assistant", "tool", "tool", "user"],
  )
})

test("悬空调用被剔除，空消息整条去掉", () => {
  const messages = [user("跑一条"), assistantCalling("c10")]
  const out = cleanupOrphanToolCalls(messages)
  assert.deepEqual(out, [user("跑一条")])
})

test("悬空调用但有正文时保留正文、只去掉 tool_calls", () => {
  const messages = [
    user("跑一条"),
    { role: "assistant", content: "我先试一下", tool_calls: [{ id: "c11", type: "function" }] },
  ]
  const out = cleanupOrphanToolCalls(messages)
  assert.equal(out.length, 2)
  assert.equal(out[1].content, "我先试一下")
  assert.equal(Object.hasOwn(out[1], "tool_calls"), false)
})

test("孤儿工具结果被删除", () => {
  const messages = [user("看结果"), toolResult("c99")]
  assert.deepEqual(cleanupOrphanToolCalls(messages), [user("看结果")])
})

test("批内只回了一半结果时，两侧按同一份配对对称裁剪", () => {
  const messages = [assistantCalling("c1", "c2"), toolResult("c1")]
  const out = cleanupOrphanToolCalls(messages)
  assert.equal(out.length, 2)
  assert.deepEqual(
    out[0].tool_calls.map((call: { id: string }) => call.id),
    ["c1"],
  )
  assert.equal(out[1].tool_call_id, "c1")
})

test("完整配对的消息一条都不动", () => {
  const messages = [user("跑两条"), assistantCalling("c00", "c01"), toolResult("c00"), toolResult("c01")]
  assert.equal(cleanupOrphanToolCalls(messages), messages)
  assert.equal(repackToolResultBlocks(messages), messages)
})

test("收口后不会出现半截配对", () => {
  const messages = [
    user("并行跑两条"),
    assistantCalling("c00", "c01"),
    toolResult("c00"),
    user("插在中间的消息"),
    toolResult("c01"),
    assistantCalling("c02"),
    toolResult("c99"),
  ]
  const out = normalizeChatToolPairing(messages)
  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of out) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) callIds.add(call.id)
    }
    if (message.role === "tool") resultIds.add(message.tool_call_id)
  }
  assert.deepEqual([...callIds].sort(), ["c00", "c01"])
  assert.deepEqual([...resultIds].sort(), ["c00", "c01"])
  // 悬空的 c02（无正文）整条去掉、孤儿结果 c99 删除，插入的 user 挪到整组之后。
  assert.deepEqual(
    out.map((message) => message.role),
    ["user", "assistant", "tool", "tool", "user"],
  )
})
