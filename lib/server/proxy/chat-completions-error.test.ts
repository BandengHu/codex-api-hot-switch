import assert from "node:assert/strict"
import test from "node:test"

import { chatCompletionsErrorResponse } from "./chat-completions-error"
import { workbuddyAccountBanClientResponse } from "./workbuddy-account-ban-response"

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

test("Chat Completions account bans preserve 11140 and the upstream reason", async () => {
  const response = workbuddyAccountBanClientResponse({
    path: "v1/chat/completions",
    status: 403,
    message: "账号存在异常行为，已被限制使用",
  })

  assert.ok(response)
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), {
    error: {
      code: "11140",
      message: "账号存在异常行为，已被限制使用",
      type: "permission_error",
    },
  })
})
