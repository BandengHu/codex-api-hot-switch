import assert from "node:assert/strict"
import test from "node:test"

import {
  formatShanghaiDay,
  isNightWindow,
  nightOwlShouldRun,
  workbuddyNightKey,
} from "./workbuddy-time"

test("WorkBuddy 日期按上海时区计算", () => {
  assert.equal(formatShanghaiDay(new Date("2026-11-13T15:59:59Z")), "2026-11-13")
  assert.equal(formatShanghaiDay(new Date("2026-11-13T16:00:00Z")), "2026-11-14")
})

test("夜猫子窗口和跨午夜晚键使用上海时间", () => {
  assert.equal(isNightWindow(new Date("2026-11-13T14:59:59Z")), false)
  assert.equal(isNightWindow(new Date("2026-11-13T15:00:00Z")), true)
  assert.equal(isNightWindow(new Date("2026-11-13T23:59:59Z")), true)
  assert.equal(isNightWindow(new Date("2026-11-13T23:59:59Z")), true)
  assert.equal(isNightWindow(new Date("2026-11-14T00:00:00Z")), false)

  const lateEvening = new Date("2026-11-13T15:30:00Z")
  const afterMidnight = new Date("2026-11-13T17:00:00Z")
  assert.equal(workbuddyNightKey(lateEvening), "2026-11-13")
  assert.equal(workbuddyNightKey(afterMidnight), "2026-11-13")
  assert.equal(
    workbuddyNightKey(new Date("2026-11-14T15:30:00Z")),
    "2026-11-14",
  )
})

test("夜猫子同一晚最多成功执行一次，窗口外不执行", () => {
  const lateEvening = new Date("2026-11-13T15:30:00Z")
  const afterMidnight = new Date("2026-11-13T17:00:00Z")
  assert.equal(nightOwlShouldRun(lateEvening, undefined), true)
  assert.equal(
    nightOwlShouldRun(afterMidnight, lateEvening.toISOString()),
    false,
  )
  assert.equal(
    nightOwlShouldRun(new Date("2026-11-13T15:30:00Z"), lateEvening.toISOString()),
    false,
  )
  assert.equal(
    nightOwlShouldRun(new Date("2026-11-14T15:30:00Z"), lateEvening.toISOString()),
    true,
  )
  assert.equal(
    nightOwlShouldRun(new Date("2026-11-13T04:00:00Z"), lateEvening.toISOString()),
    false,
  )
})
