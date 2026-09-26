import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { normalizeResponsesErrorFields, normalizeUpstreamErrorPayload } from "./upstream-error"

test("上游错误提取：嵌套 msg 还原成人类可读原因", () => {
  const payload = {
    error: {
      message: JSON.stringify({
        code: 6004,
        msg: "您的使用量已超出频率限制，将在 2026-09-25 17:26:57 UTC+8 重置后使用",
      }),
      type: "upstream_error",
      code: 6004,
    },
  }
  const transformed = normalizeUpstreamErrorPayload(payload, 429)
  assert.equal(
    transformed.error.message,
    "您的使用量已超出频率限制，将在 2026-09-25 17:26:57 UTC+8 重置后使用",
  )
})

test("数字业务码规范成字符串，否则 Codex 会整体丢弃 error 对象", () => {
  const transformed = normalizeUpstreamErrorPayload(
    {
      error: {
        message: "您的使用量已超出频率限制，将在 2026-09-26 13:10:37 UTC+8 重置",
        type: "upstream_error",
        code: 6004,
      },
    },
    429,
  )
  assert.equal(transformed.error.code, "6004")
  assert.equal(typeof transformed.error.code, "string")
})

test("数字 status_code 同样规范成字符串", () => {
  const transformed = normalizeUpstreamErrorPayload(
    { error: { message: "too many requests", status_code: 429 } },
    429,
  )
  assert.equal(transformed.error.code, "429")
})

test("非字符串 type 一并规范化，不丢消息", () => {
  const asNumber = normalizeResponsesErrorFields({
    message: "rate limited",
    type: 6004,
    code: 6004,
  })
  assert.equal(asNumber.type, "6004")
  assert.equal(asNumber.code, "6004")

  const asObject = normalizeResponsesErrorFields({ message: "rate limited", type: { nested: true } })
  assert.equal("type" in asObject, false)
  assert.equal(asObject.message, "rate limited")
})

test("语义码保持原样，不被字符串化破坏", () => {
  const transformed = normalizeUpstreamErrorPayload(
    { error: { message: "quota", type: "rate_limit_error", code: "rate_limit_exceeded" } },
    429,
  )
  assert.equal(transformed.error.code, "rate_limit_exceeded")
  assert.equal(transformed.error.type, "rate_limit_error")
})
