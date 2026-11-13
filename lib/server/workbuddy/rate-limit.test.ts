import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import {
  isWorkbuddyRateLimitPrefix,
  WorkbuddyRateLimitError,
  workbuddyRateLimitFromPayload,
  workbuddyRateLimitFromText,
} from "./rate-limit"

const MESSAGE =
  "您的使用量已超出频率限制，将在 2026-10-30 10:43:32 UTC+8 重置，您也可以切换其他模型继续使用。"

test("WorkBuddy frequency limit preserves its message and converts reset time to UTC", () => {
  assert.deepEqual(workbuddyRateLimitFromText(MESSAGE), {
    message: MESSAGE,
    resetAt: "2026-10-30T02:43:32.000Z",
  })
})

test("WorkBuddy frequency limit is found inside nested SSE payloads", () => {
  assert.deepEqual(
    workbuddyRateLimitFromPayload({
      choices: [{ delta: { content: MESSAGE } }],
    }),
    {
      message: MESSAGE,
      resetAt: "2026-10-30T02:43:32.000Z",
    },
  )
})

test("generic quota text does not trigger account freezing", () => {
  assert.equal(workbuddyRateLimitFromText("rate limit exceeded"), null)
  assert.equal(
    workbuddyRateLimitFromText("您的使用量已超出频率限制，请稍后重试"),
    null,
  )
})

test("invalid WorkBuddy reset timestamps are rejected", () => {
  assert.equal(
    workbuddyRateLimitFromText(
      "您的使用量已超出频率限制，将在 2026-99-99 10:43:32 UTC+8 重置，您也可以切换其他模型继续使用。",
    ),
    null,
  )
})

test("WorkBuddy rate limit keeps the exact upstream message and a 429 classification", () => {
  const parsed = workbuddyRateLimitFromText(MESSAGE)
  assert.ok(parsed)
  const error = new WorkbuddyRateLimitError(parsed)
  assert.equal(error.kind, "quota")
  assert.equal(error.status, 429)
  assert.equal(error.message, MESSAGE)
  assert.deepEqual(error.payload, parsed)
})

test("WorkBuddy rate limit recognizes every split prefix of the exact message", () => {
  for (let index = 0; index <= MESSAGE.length; index += 1) {
    const text = MESSAGE.slice(0, index)
    assert.equal(isWorkbuddyRateLimitPrefix(text), true, text)
  }
  assert.deepEqual(workbuddyRateLimitFromText(MESSAGE), {
    message: MESSAGE,
    resetAt: "2026-10-30T02:43:32.000Z",
  })

  assert.equal(
    isWorkbuddyRateLimitPrefix(
      "您的使用量已超出频率限制，将在 2026-10-30 10:43:32 UTC+8 正常回答",
    ),
    false,
  )
})
