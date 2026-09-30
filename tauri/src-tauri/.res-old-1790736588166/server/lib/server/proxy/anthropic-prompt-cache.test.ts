import assert from "node:assert/strict"
import test from "node:test"

import {
  applyAnthropicPromptCaching,
  countAnthropicPromptCacheBreakpoints,
} from "./anthropic-prompt-cache"

function longClaudeBody() {
  return {
    model: "claude-sonnet-5",
    tools: [
      { name: "first", input_schema: { type: "object" } },
      { name: "last", input_schema: { type: "object" } },
    ],
    system: [{ type: "text", text: "system" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }],
      },
      { role: "assistant", content: [{ type: "text", text: "latest" }] },
    ],
  } as any
}

test("Anthropic 长对话使用 tools、system、最新消息和较旧 user 四个断点", () => {
  const body = longClaudeBody()

  applyAnthropicPromptCaching(body)

  assert.equal(countAnthropicPromptCacheBreakpoints(body), 4)
  assert.equal(body.tools[0].cache_control, undefined)
  assert.deepEqual(body.tools[1].cache_control, { type: "ephemeral" })
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" })
  assert.deepEqual(body.messages[3].content[0].cache_control, { type: "ephemeral" })
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral" })
  assert.equal(body.messages[2].content[0].cache_control, undefined)
})

test("Anthropic 缓存断点跳过 thinking 块", () => {
  const body = {
    model: "claude-sonnet-5",
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "hidden" },
        ],
      },
    ],
  } as any

  applyAnthropicPromptCaching(body)

  assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral" })
  assert.equal(body.messages[0].content[1].cache_control, undefined)
})

test("Anthropic 保留调用方已有断点且总数不超过四个", () => {
  const body = longClaudeBody()
  body.tools[0].cache_control = { type: "ephemeral", ttl: "1h" }
  body.system[0].cache_control = { type: "ephemeral" }

  applyAnthropicPromptCaching(body)

  assert.equal(countAnthropicPromptCacheBreakpoints(body), 4)
  assert.deepEqual(body.tools[0].cache_control, { type: "ephemeral", ttl: "1h" })
  assert.deepEqual(body.tools[1].cache_control, { type: "ephemeral" })
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" })
  assert.deepEqual(body.messages[3].content[0].cache_control, { type: "ephemeral" })
  assert.equal(body.messages[0].content[0].cache_control, undefined)
})

test("非 Claude Anthropic 兼容模型不主动注入缓存断点", () => {
  const body = {
    model: "deepseek-v4",
    tools: [{ name: "tool" }],
    system: [{ type: "text", text: "system" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  } as any
  const original = structuredClone(body)

  applyAnthropicPromptCaching(body)

  assert.deepEqual(body, original)
})

test("超过四个调用方断点时完整保留并输出告警", () => {
  const body = longClaudeBody()
  body.tools[0].cache_control = { type: "ephemeral" }
  body.tools[1].cache_control = { type: "ephemeral" }
  body.system[0].cache_control = { type: "ephemeral" }
  body.messages[0].content[0].cache_control = { type: "ephemeral" }
  body.messages[1].content[0].cache_control = { type: "ephemeral" }
  const original = structuredClone(body)
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (message?: unknown) => warnings.push(String(message))

  try {
    applyAnthropicPromptCaching(body)
  } finally {
    console.warn = originalWarn
  }

  assert.deepEqual(body, original)
  assert.equal(countAnthropicPromptCacheBreakpoints(body), 5)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /已有 5 个/)
})
