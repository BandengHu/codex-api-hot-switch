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
const QUOTA_EXHAUSTED_MESSAGE =
  "额度已用尽，请访问以下链接，购买加量包以获取更多额度：https://www.codebuddy.cn/profile/usage "

test("WorkBuddy frequency limit preserves its message and converts reset time to UTC", () => {
  assert.deepEqual(workbuddyRateLimitFromText(MESSAGE), {
    message: MESSAGE,
    kind: "frequency_limit",
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
      kind: "frequency_limit",
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
    kind: "frequency_limit",
    resetAt: "2026-10-30T02:43:32.000Z",
  })

  assert.equal(
    isWorkbuddyRateLimitPrefix(
      "您的使用量已超出频率限制，将在 2026-10-30 10:43:32 UTC+8 正常回答",
    ),
    false,
  )
})

test("WorkBuddy quota exhaustion is detected from nested payload and has no reset time", () => {
  assert.deepEqual(
    workbuddyRateLimitFromPayload({
      data: {
        code: 14018,
        msg: QUOTA_EXHAUSTED_MESSAGE,
        requestId: "request-1",
      },
    }),
    {
      kind: "quota_exhausted",
      message: QUOTA_EXHAUSTED_MESSAGE.trim(),
    },
  )
})

test("WorkBuddy quota exhaustion can be parsed from JSON text", () => {
  const payload = JSON.stringify({
    data: {
      code: "14018",
      msg: QUOTA_EXHAUSTED_MESSAGE,
    },
  })
  assert.deepEqual(workbuddyRateLimitFromText(payload), {
    kind: "quota_exhausted",
    message: QUOTA_EXHAUSTED_MESSAGE.trim(),
  })
})

test("14018 without the exact quota-exhausted message is not classified", () => {
  assert.equal(
    workbuddyRateLimitFromPayload({
      data: { code: 14018, msg: "some unrelated error" },
    }),
    null,
  )
})

test("WorkBuddy quota exhaustion is found in plain text with a transport prefix", () => {
  const payload = JSON.stringify({
    data: { code: 14018, msg: QUOTA_EXHAUSTED_MESSAGE },
  })
  assert.deepEqual(
    workbuddyRateLimitFromText(`Illegal API invocation: ${payload}`),
    {
      kind: "quota_exhausted",
      message: QUOTA_EXHAUSTED_MESSAGE.trim(),
    },
  )
})
