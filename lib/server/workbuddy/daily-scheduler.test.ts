import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import {
  formatScheduleDay,
  normalizeDailyScheduleState,
  pickAccountsNeedingRun,
  summarizeDailyRun,
  type DailyScheduleState,
} from "./daily-scheduler"
import type { WorkbuddyPoolEntry } from "./task-pool-store"

function entry(uid: string, disabled = false): WorkbuddyPoolEntry {
  return { uid, nickname: uid, source: "file", disabled }
}

test("每日排程：只挑今天没跑且未禁用的账号", () => {
  const entries = [entry("local"), entry("a", true), entry("b")]
  const state: DailyScheduleState = {
    version: 1,
    lastRunByUid: { local: "2026-09-25" },
  }
  const picked = pickAccountsNeedingRun(entries, state, "2026-09-25")
  assert.deepEqual(picked.map((item) => item.uid), ["b"])
})

test("每日排程：跨日重置，同一天不重复", () => {
  const entries = [entry("local")]
  const state: DailyScheduleState = {
    version: 1,
    lastRunByUid: { local: "2026-09-24" },
  }
  assert.equal(pickAccountsNeedingRun(entries, state, "2026-09-25").length, 1)
  assert.equal(pickAccountsNeedingRun(entries, state, "2026-09-24").length, 0)
})

test("每日排程：日期按上海时区格式化", () => {
  assert.equal(formatScheduleDay(new Date("2026-09-25T16:00:00Z")), "2026-09-26")
  assert.equal(formatScheduleDay(new Date("2026-09-25T15:59:59Z")), "2026-09-25")
})

test("每日排程：坏状态文件重置为 v1", () => {
  assert.deepEqual(normalizeDailyScheduleState(null), { version: 1, lastRunByUid: {} })
  assert.deepEqual(
    normalizeDailyScheduleState({
      version: 1,
      lastRunByUid: { local: " 2026-09-25 ", bad: "" },
      lastResultByUid: { local: "入账 +1分" },
    }),
    {
      version: 1,
      lastRunByUid: { local: "2026-09-25" },
      lastResultByUid: { local: "入账 +1分" },
    },
  )
})

test("每日排程：结果摘要保留入账与异常", () => {
  const summary = summarizeDailyRun({
    creditTotal: 5,
    streakDays: 3,
    steps: [
      { key: "checkin", label: "每日签到", status: "done", message: "签到成功" },
      { key: "lottery", label: "抽奖", status: "error", message: "请求超时" },
    ],
  })
  assert.equal(summary, "入账 +5分；连登 3天；异常 1项：抽奖 请求超时")
})
