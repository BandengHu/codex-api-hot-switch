import assert from "node:assert/strict"
import test from "node:test"

import {
  CONTEXT_CHECKPOINT_RECOVERY_INSTRUCTION,
  isContextCheckpointRecovery,
  normalizeContextCheckpointRecoveryMessages,
} from "./context-checkpoint-recovery"

const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
})

test("Codex 交接摘要触发恢复指令", () => {
  const messages = [
    { role: "system", content: "系统约束" },
    { role: "user", content: "已经处理过的旧问题" },
    {
      role: "user",
      content:
      "Another language model started to solve this problem and produced a summary of its thinking process.\n"
        + "# 交接摘要\n当前主线：继续修复。",
    },
  ]

  const normalized = normalizeContextCheckpointRecoveryMessages(messages)

  assert.equal(isContextCheckpointRecovery(messages), true)
  assert.deepEqual(normalized.map((message) => message.role), ["system", "user", "system"])
  assert.equal(normalized.some((message) => message.content === "已经处理过的旧问题"), false)
  assert.deepEqual(normalized.at(-1), {
    role: "system",
    content: CONTEXT_CHECKPOINT_RECOVERY_INSTRUCTION,
  })
})

test("本地 compact fallback 的 checkpoint 标签触发恢复指令", () => {
  const input = [
    user("<conversation-checkpoint>\n## Goal\n- 继续当前任务\n</conversation-checkpoint>"),
  ]

  assert.equal(isContextCheckpointRecovery(input), true)
})

test("checkpoint 后只有工具结果时仍保留 checkpoint 与工具结果", () => {
  const messages = [
    { role: "user", content: "旧问题" },
    {
      role: "user",
      content:
      "Another language model started to solve this problem and produced a summary of its thinking process.\n"
        + "下一步：运行测试。",
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: "测试通过",
    },
  ]

  const normalized = normalizeContextCheckpointRecoveryMessages(messages)

  assert.equal(isContextCheckpointRecovery(messages), true)
  assert.deepEqual(normalized.map((message) => message.role), ["user", "tool", "system"])
  assert.equal(normalized[0].content.includes("下一步：运行测试"), true)
})

test("checkpoint 后出现新的用户消息时保留新任务并清除旧历史", () => {
  const messages = [
    { role: "user", content: "压缩前已经处理完的旧问题" },
    { role: "user", content: "<conversation-checkpoint>\n旧摘要\n</conversation-checkpoint>" },
    { role: "user", content: "这是压缩后新发的任务" },
  ]

  const normalized = normalizeContextCheckpointRecoveryMessages(messages)

  assert.equal(isContextCheckpointRecovery(messages), true)
  assert.deepEqual(normalized.map((message) => message.role), ["user", "user", "system"])
  assert.equal(normalized[0].content.includes("旧摘要"), true)
  assert.equal(normalized[1].content, "这是压缩后新发的任务")
  assert.equal(normalized.some((message) => message.content === "压缩前已经处理完的旧问题"), false)
})

test("checkpoint 后发送继续时仍能从摘要恢复", () => {
  const messages = [
    { role: "user", content: "压缩前已经处理完的旧问题" },
    {
      role: "user",
      content:
        "Another language model started to solve this problem and produced a summary of its thinking process.\n"
        + "当前主线：排查 chat_5。\n下一步：检查 streak。",
    },
    { role: "user", content: "继续" },
  ]

  const normalized = normalizeContextCheckpointRecoveryMessages(messages)

  assert.deepEqual(normalized.map((message) => message.role), ["user", "user", "system"])
  assert.equal(normalized[0].content.includes("当前主线：排查 chat_5"), true)
  assert.equal(normalized[1].content, "继续")
  assert.equal(normalized.some((message) => message.content === "压缩前已经处理完的旧问题"), false)
})

test("AGENTS 指令被提升为 system，普通历史用户消息被摘要替代", () => {
  const messages = [
    { role: "user", content: "旧任务" },
    { role: "user", content: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\n只能使用 pwsh\n</INSTRUCTIONS>" },
    {
      role: "user",
      content:
        "Another language model started to solve this problem and produced a summary of its thinking process.\n"
        + "当前主线：继续。",
    },
  ]

  const normalized = normalizeContextCheckpointRecoveryMessages(messages)

  assert.deepEqual(normalized.map((message) => message.role), ["system", "user", "system"])
  assert.equal(normalized[0].content.includes("只能使用 pwsh"), true)
  assert.equal(normalized.some((message) => message.content === "旧任务"), false)
})

test("生成 checkpoint 的压缩提示不会被误判成恢复请求", () => {
  const input = [
    user(
      "You are performing a CONTEXT CHECKPOINT COMPACTION. "
        + "Create a handoff summary for another LLM that will resume the task.",
    ),
  ]

  assert.equal(isContextCheckpointRecovery(input), false)
})
