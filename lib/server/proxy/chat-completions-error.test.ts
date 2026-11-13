import assert from "node:assert/strict"
import test from "node:test"

import { chatCompletionsErrorResponse } from "./chat-completions-error"

const MESSAGE =
  "您的使用量已超出频率限制，将在 2026-10-30 10:43:32 UTC+8 重置，您也可以切换其他模型继续使用。"

test("Chat Completions errors preserve the upstream rate-limit message and status", async () => {
  const response = chatCompletionsErrorResponse({
    status: 429,
    message: MESSAGE,
    type: "rate_limit_error",
    headers: {
      "x-codex-hot-switch-upstream-error": "429",
    },
  })

  assert.equal(response.status, 429)
  assert.equal(
    response.headers.get("x-codex-hot-switch-upstream-error"),
    "429",
  )
  assert.deepEqual(await response.json(), {
    error: {
      message: MESSAGE,
      type: "rate_limit_error",
    },
  })
})
