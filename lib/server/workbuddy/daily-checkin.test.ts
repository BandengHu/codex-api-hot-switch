import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { setProviderFetchForTesting } from "@/lib/server/proxy/provider-fetch"
import type { WorkbuddyAccount } from "./account"
import {
  classifyDailyCheckin,
  dailyCheckin,
  fetchCheckinActivityStatus,
  isAlreadyDoneError,
} from "./daily-api"
import { WorkbuddyTaskApiError } from "./api-client"

const account = {
  accessToken: "checkin-token",
  refreshToken: "",
  expiresAt: 0,
  domain: "www.codebuddy.cn",
  uid: "checkin-uid",
  nickname: "",
  uin: "",
} satisfies WorkbuddyAccount

test("签到分类：pending → failed → already → checked", () => {
  assert.equal(classifyDailyCheckin(0, "请求处理中，请勿重复操作"), "pending")
  assert.equal(classifyDailyCheckin(0, "签到失败，已签到天数不足 7 天"), "failed")
  assert.equal(classifyDailyCheckin(0, "今天已签到，请明天再来"), "already")
  assert.equal(classifyDailyCheckin(0, "签到成功"), "checked")
  assert.equal(classifyDailyCheckin(10001, "今天已签到，请明天再来"), "already")
})

test("签到成功保留平铺 credit，不伪造未知数值", async () => {
  let calls = 0
  const previous = setProviderFetchForTesting(async () => {
    calls += 1
    return new Response(JSON.stringify({ code: 0, credit: 100, streak_days: 7 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  try {
    const receipt = await dailyCheckin(account)
    assert.deepEqual(receipt, {
      state: "checked",
      credit: 100,
      creditKnown: true,
      streakDays: 7,
      code: 0,
      message: "",
    })
    assert.equal(calls, 1)
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("签到 HTTP 400 回执按内容分类，而不是一律异常", async () => {
  const cases = [
    ["请求处理中，请勿重复操作", "pending"],
    ["签到失败，已签到天数不足 7 天", "failed"],
    ["今天已签到，请明天再来", "already"],
  ] as const
  for (const [message, state] of cases) {
    const previous = setProviderFetchForTesting(async () =>
      new Response(JSON.stringify({ code: 10001, msg: message }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    )
    try {
      const receipt = await dailyCheckin(account)
      assert.equal(receipt.state, state)
      assert.equal(receipt.message, message)
    } finally {
      setProviderFetchForTesting(previous)
    }
  }
})

test("普通网络错误不能被归类成签到成功或已签到", async () => {
  const previous = setProviderFetchForTesting(async () => {
    throw new Error("fetch failed")
  })
  try {
    await assert.rejects(dailyCheckin(account), WorkbuddyTaskApiError)
    assert.equal(
      isAlreadyDoneError(new WorkbuddyTaskApiError(
        '每日签到：HTTP 400 {"code":10001,"msg":"签到失败，已签到天数不足 7 天"}',
        "",
        400,
      )),
      false,
    )
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("官方签到状态从 data 读取今日结果", async () => {
  const previous = setProviderFetchForTesting(async (input) => {
    assert.equal(
      new URL(String(input)).pathname,
      "/v2/billing/meter/checkin-activity-status",
    )
    return new Response(JSON.stringify({
      code: 0,
      data: {
        today_checked_in: true,
        streak_days: 13,
        daily_credit: 100,
        today_credit: 300,
        active: true,
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })
  try {
    assert.deepEqual(await fetchCheckinActivityStatus(account), {
      todayCheckedIn: true,
      streakDays: 13,
      dailyCredit: 100,
      todayCredit: 300,
      active: true,
    })
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("官方签到状态查询失败必须抛错，不能当成未签到", async () => {
  const previous = setProviderFetchForTesting(async () => {
    throw new Error("network down")
  })
  try {
    await assert.rejects(
      fetchCheckinActivityStatus(account),
      WorkbuddyTaskApiError,
    )
  } finally {
    setProviderFetchForTesting(previous)
  }
})
