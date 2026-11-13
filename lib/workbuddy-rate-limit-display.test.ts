import assert from "node:assert/strict"
import test from "node:test"

import {
  formatWorkbuddyRateLimitRecovery,
  formatWorkbuddyRateLimitReset,
} from "./workbuddy-rate-limit-display"

test("限频恢复时间按 Asia/Shanghai 显示今天和明天", () => {
  const now = new Date("2026-11-13T06:00:00.000Z")
  assert.equal(
    formatWorkbuddyRateLimitReset("2026-11-13T07:26:06.000Z", now),
    "今天 15:26",
  )
  assert.equal(
    formatWorkbuddyRateLimitReset("2026-11-13T09:43:05.000Z", now),
    "今天 17:43",
  )
  assert.equal(
    formatWorkbuddyRateLimitReset("2026-11-13T13:03:32.000Z", now),
    "今天 21:03",
  )
  assert.equal(
    formatWorkbuddyRateLimitReset("2026-11-14T01:35:09.000Z", now),
    "明天 09:35",
  )
})

test("限频恢复时间用上海自然日判断，不跟宿主时区漂移", () => {
  const now = new Date("2026-11-13T15:30:00.000Z")
  assert.equal(
    formatWorkbuddyRateLimitReset("2026-11-14T15:45:00.000Z", now),
    "明天 23:45",
  )
})

test("四条当前限频账号的恢复文案", () => {
  const now = new Date("2026-11-13T04:00:00.000Z")
  assert.equal(
    formatWorkbuddyRateLimitRecovery("2026-11-13T07:26:06.000Z", now),
    "今天 15:26 恢复",
  )
  assert.equal(
    formatWorkbuddyRateLimitRecovery("2026-11-13T09:43:05.000Z", now),
    "今天 17:43 恢复",
  )
  assert.equal(
    formatWorkbuddyRateLimitRecovery("2026-11-13T13:03:32.000Z", now),
    "今天 21:03 恢复",
  )
  assert.equal(
    formatWorkbuddyRateLimitRecovery("2026-11-14T01:35:09.000Z", now),
    "明天 09:35 恢复",
  )
})

test("过期限频保留恢复点，无效时间不展示", () => {
  const now = new Date("2026-11-13T08:00:00.000Z")
  assert.equal(
    formatWorkbuddyRateLimitRecovery("2026-11-13T07:59:00.000Z", now),
    "今天 15:59 已恢复",
  )
  assert.equal(formatWorkbuddyRateLimitRecovery("not-a-date", now), "")
})
