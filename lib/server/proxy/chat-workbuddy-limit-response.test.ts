import assert from "node:assert/strict"
import test from "node:test"

import { WorkbuddyRateLimitError } from "@/lib/server/workbuddy/rate-limit"
import { workbuddyAccountBanClientResponse } from "./workbuddy-account-ban-response"
import { workbuddyRateLimitClientResponse } from "./workbuddy-rate-limit-response"

const MESSAGE =
  "您的使用量已超出频率限制，将在 2026-10-30 10:43:32 UTC+8 重置，您也可以切换其他模型继续使用。"

function responseForPath(path: string, error: WorkbuddyRateLimitError) {
  return workbuddyRateLimitClientResponse({
    path,
    status: error.status ?? 429,
    message: error.message,
    headers: {
      "x-codex-hot-switch-upstream-error": String(error.status),
    },
  }) ?? new Response(
    `event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      response: {
        status: "failed",
        error: {
          message: error.message,
          type: "rate_limit_error",
        },
      },
    })}\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  )
}

test("a Chat Completions request receives a standard 429 error for an exhausted WorkBuddy pool", async () => {
  const error = new WorkbuddyRateLimitError({
    message: MESSAGE,
    resetAt: "2026-10-30T02:43:32.000Z",
  })
  const response = responseForPath("v1/chat/completions", error)

  assert.equal(response.status, 429)
  assert.match(response.headers.get("content-type") || "", /application\/json/)
  assert.deepEqual(await response.json(), {
    error: {
      message: MESSAGE,
      type: "rate_limit_error",
    },
  })
})

test("the Responses path keeps its existing response.failed error event", async () => {
  const error = new WorkbuddyRateLimitError({
    message: MESSAGE,
    resetAt: "2026-10-30T02:43:32.000Z",
  })
  const response = responseForPath("v1/responses", error)
  const text = await response.text()

  assert.equal(response.status, 200)
  assert.match(text, /event: response\.failed/)
  assert.ok(text.includes(MESSAGE))
})

test("a non-streaming Chat ban exposes the upstream reason and business code", async () => {
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
