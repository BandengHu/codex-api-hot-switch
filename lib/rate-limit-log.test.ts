import assert from "node:assert/strict"
import test from "node:test"

import type { RequestLog } from "./types"
import { extractRateLimitResetAt, latestRateLimitHint } from "./rate-limit-log"

function log(values: Partial<RequestLog>): RequestLog {
  return {
    id: "log-test",
    timestamp: "2026-09-25T09:26:57.000Z",
    codexModel: "deepseek-v4.1-flash",
    finalProviderId: "prov-workbuddy",
    finalModelId: "deepseek-v4.1-flash",
    reasoning: "off",
    statusCode: 429,
    durationMs: 100,
    rawRequest: "{}",
    rewrittenRequest: "{}",
    responseSummary: "",
    ...values,
  }
}

test("频率限制提示：从旧日志 responseSummary 中还原上游 msg", () => {
  const hint = latestRateLimitHint([
    log({
      error: "上游返回 HTTP 429 Too Many Requests",
      responseSummary: JSON.stringify({
        error: {
          message: JSON.stringify({
            code: 6004,
            msg: "您的使用量已超出频率限制，将在 2026-09-25 17:26:57 UTC+8 重置后使用",
          }),
        },
      }),
    }),
  ])
  assert.equal(
    hint?.message,
    "您的使用量已超出频率限制，将在 2026-09-25 17:26:57 UTC+8 重置后使用",
  )
  assert.equal(hint?.resetAt, "2026-09-25 17:26:57")
})

test("频率限制提示：非 429 或普通网关文案不触发", () => {
  assert.equal(latestRateLimitHint([log({ statusCode: 200 })]), null)
  assert.equal(
    latestRateLimitHint([log({ error: "上游返回 HTTP 429 Too Many Requests" })]),
    null,
  )
})

test("频率限制提示：能抽取重置时间", () => {
  assert.equal(
    extractRateLimitResetAt("已超出频率限制，将在 2026-09-25 17:26:57 UTC+8 重置后使用"),
    "2026-09-25 17:26:57",
  )
})
