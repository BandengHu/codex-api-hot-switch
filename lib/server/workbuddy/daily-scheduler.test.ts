import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import {
  formatScheduleDay,
  normalizeDailyScheduleState,
  clearNightOwlRun,
  pickAccountsNeedingRun,
  summarizeDailyRun,
  updateDailyRunState,
  type DailyScheduleState,
} from "./daily-scheduler"
import type { WorkbuddyPoolEntry } from "./task-pool-store"

function entry(uid: string, disabled = false): WorkbuddyPoolEntry {
  return { uid, nickname: uid, source: "file", disabled }
}

test("每日排程：只挑今天没跑且未禁用的账号", () => {
  const entries = [entry("local"), entry("a", true), entry("b")]
  const state: DailyScheduleState = {
    version: 4,
    lastRunByUid: { local: "2026-09-25" },
  }
  const picked = pickAccountsNeedingRun(entries, state, "2026-09-25")
  assert.deepEqual(picked.map((item) => item.uid), ["b"])
})

test("每日排程：跨日重置，同一天不重复", () => {
  const entries = [entry("local")]
  const state: DailyScheduleState = {
    version: 4,
    lastRunByUid: { local: "2026-09-24" },
  }
  assert.equal(pickAccountsNeedingRun(entries, state, "2026-09-25").length, 1)
  assert.equal(pickAccountsNeedingRun(entries, state, "2026-09-24").length, 0)
})

test("每日排程：到期才补跑，未到期跳过，成功后清除", () => {
  const entries = [entry("local")]
  const now = Date.parse("2026-09-28T00:00:00+08:00")
  const initial: DailyScheduleState = { version: 4, lastRunByUid: {} }
  const pending = updateDailyRunState(
    initial,
    "local",
    "请求超时",
    true,
    "2026-09-28",
    now,
  )
  assert.equal(
    pickAccountsNeedingRun(entries, pending, "2026-09-28", now + 9 * 60_000).length,
    0,
  )
  assert.equal(
    pickAccountsNeedingRun(entries, pending, "2026-09-28", now + 10 * 60_000).length,
    1,
  )
  assert.deepEqual(initial, { version: 4, lastRunByUid: {} })
  const success = updateDailyRunState(
    pending,
    "local",
    "签到成功",
    false,
    "2026-09-28",
    now,
  )
  assert.equal(success.nextRetryAtByUid, undefined)
  assert.equal(pickAccountsNeedingRun(entries, success, "2026-09-28", now).length, 0)
  assert.equal(pickAccountsNeedingRun(entries, success, "2026-09-29", now).length, 1)
})

test("每日排程：第二次待重试改为 40 分钟后", () => {
  const now = Date.parse("2026-09-28T00:00:00+08:00")
  const first = updateDailyRunState(
    { version: 4, lastRunByUid: {} },
    "local",
    "第一次超时",
    true,
    "2026-09-28",
    now,
  )
  const second = updateDailyRunState(
    first,
    "local",
    "第二次仍待补跑",
    true,
    "2026-09-28",
    now + 10 * 60_000,
  )
  assert.equal(
    second.nextRetryAtByUid?.local,
    new Date(now + 50 * 60_000).toISOString(),
  )
})

test("每日排程：日期按上海时区格式化", () => {
  assert.equal(formatScheduleDay(new Date("2026-09-25T16:00:00Z")), "2026-09-26")
  assert.equal(formatScheduleDay(new Date("2026-09-25T15:59:59Z")), "2026-09-25")
})

test("每日排程：坏状态重置，v3 保留当日执行记录", () => {
  assert.deepEqual(normalizeDailyScheduleState(null), { version: 4, lastRunByUid: {} })
  assert.deepEqual(normalizeDailyScheduleState({
    version: 3,
    lastRunByUid: { local: "2026-09-28" },
    retryPendingByUid: { local: true },
    lastResultByUid: { local: "无新增积分" },
  }), {
    version: 4,
    lastRunByUid: { local: "2026-09-28" },
    lastResultByUid: { local: "无新增积分" },
  })
  assert.deepEqual(normalizeDailyScheduleState({
    version: 1,
    lastRunByUid: { local: "2026-09-28" },
  }), { version: 4, lastRunByUid: {} })
})

test("每日排程：真实 v2 状态迁移后保留待重试账号", () => {
  const state = normalizeDailyScheduleState({
    version: 2,
    lastRunByUid: {
      local: "2026-11-13",
      imported: "2026-11-13",
    },
    lastResultByUid: {
      local: "入账 +7分",
      imported: "请求超时",
    },
    retryPendingByUid: {
      imported: true,
      finished: false,
    },
  })
  assert.equal(state.version, 4)
  assert.equal(state.lastRunByUid.imported, "2026-11-13")
  assert.equal(state.retryCountByUid?.imported, undefined)
  assert.ok(state.nextRetryAtByUid?.imported)
  assert.equal(state.nextRetryAtByUid?.finished, undefined)
  assert.equal(state.lastResultByUid?.local, "入账 +7分")
})

test("每日排程：保存官方签到确认并可跨日清除", () => {
  const now = Date.parse("2026-11-13T10:00:00+08:00")
  const state = updateDailyRunState(
    { version: 4, lastRunByUid: {} },
    "local",
    "官方确认今日已签到",
    false,
    "2026-11-13",
    now,
    {
      todayCheckedIn: true,
      todayCredit: 100,
      streakDays: 13,
      checkedAt: new Date(now).toISOString(),
    },
  )
  assert.deepEqual(state.checkinByUid?.local, {
    day: "2026-11-13",
    todayCheckedIn: true,
    todayCredit: 100,
    streakDays: 13,
    checkedAt: new Date(now).toISOString(),
  })

  const nextDay = updateDailyRunState(
    state,
    "local",
    "查询失败",
    true,
    "2026-11-14",
    now + 86_400_000,
  )
  assert.equal(nextDay.checkinByUid, undefined)
})

test("每日排程：结果摘要保留入账与异常", () => {
  const summary = summarizeDailyRun({
    creditTotal: 5,
    streakDays: 3,
    steps: [
      { key: "checkin", label: "每日签到", status: "done", message: "签到成功" },
      { key: "lottery", label: "抽奖", status: "error", message: "请求超时", retryable: true },
    ],
  })
  assert.equal(summary, "入账 +5分；连登 3天；异常 1项：抽奖 请求超时；等待自动重试")
})

test("每日排程：分享进度暂未点亮仍保留自动补跑", () => {
  assert.match(summarizeDailyRun({
    creditTotal: 0,
    steps: [{ key: "school_share", label: "开学季分享", status: "skipped", message: "进度未点亮", retryable: true }],
  }), /等待自动重试/)
})

test("每日排程：夜猫子晚键独立于普通每日执行记录持久化", () => {
  const normalized = normalizeDailyScheduleState({
    version: 4,
    lastRunByUid: { local: "2026-11-13" },
    nightOwlByUid: { local: "2026-11-13" },
  })
  assert.equal(normalized.nightOwlByUid?.local, "2026-11-13")
  assert.equal(clearNightOwlRun(normalized, "local").nightOwlByUid, undefined)
  assert.equal(clearNightOwlRun(normalized, "other").nightOwlByUid?.local, "2026-11-13")
})
