import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { normalizeUpstreamErrorPayload } from "./upstream-error"

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
