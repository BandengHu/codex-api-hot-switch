import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { setProviderFetchForTesting } from "@/lib/server/proxy/provider-fetch"
import type { WorkbuddyAccount } from "./account"
import { runDailyRewards } from "./daily-automation"

const account = {
  accessToken: "daily-token",
  refreshToken: "",
  expiresAt: 0,
  domain: "www.codebuddy.cn",
  uid: "daily-uid",
  nickname: "",
  uin: "",
} satisfies WorkbuddyAccount

function json(data: unknown, status = 200) {
  return Response.json({ code: 0, data }, { status })
}

test("旅行奖励到账后状态回读失败只记一次积分并保留独立错误", async () => {
  let travelReads = 0
  const previous = setProviderFetchForTesting(async (input, init) => {
    const path = new URL(String(input)).pathname
    const method = init?.method || "GET"

    if (path === "/v2/report") return Response.json({ code: 0, data: {} })
    if (path === "/activity/growth/streak" && method === "GET") {
      return json({
        streak: { days: 1 },
        makeup_cards: { balance: 0 },
        redemption_status: { tiers: [] },
      })
    }
    if (path === "/v2/billing/meter/checkin-activity-status") {
      return json({
        today_checked_in: true,
        streak_days: 1,
        daily_credit: 7,
        today_credit: 7,
        active: true,
      })
    }
    if (path === "/v2/billing/meter/daily-checkin") {
      return Response.json({ code: 0, credit: 7, streak_days: 1 })
    }
    if (path.endsWith("/claim-gift") || path.endsWith("/claim-compensation")) {
      return Response.json({ code: 10001, msg: "已领取" }, { status: 400 })
    }
    if (path === "/activity/growth/lottery/summary") return json({ chances: 0 })
    if (path === "/activity/growth/heatmap") return json({ cells: [] })
    if (path === "/activity/growth/buddy/info") {
      return json({ buddy: { instance_id: 1, name: "猫猫", rarity: "common" } })
    }
    if (path === "/activity/growth/buddy/travel/status") {
      travelReads += 1
      if (travelReads === 1) {
        return json({ state: "arrived", reward_credit: 8, record_id: 42 })
      }
      throw new Error("travel status unavailable")
    }
    if (path === "/activity/growth/buddy/travel/claim") {
      return json({ reward_credit: 8 })
    }
    if (path === "/v2/activity/growth/buddy/quota") {
      return json({ affordable: 0, max_open_count: 1 })
    }
    throw new Error(`unexpected request ${method} ${path}`)
  })

  try {
    const result = await runDailyRewards(account)
    const travel = result.steps.filter((step) => step.key === "travel")
    assert.deepEqual(
      travel.map((step) => ({ status: step.status, credit: step.credit })),
      [{ status: "done", credit: 8 }],
    )
    assert.equal(result.creditTotal, 15)
    const stateError = result.steps.find((step) => step.key === "travel_state")
    assert.equal(stateError?.status, "error")
    assert.match(stateError?.message || "", /奖励已领取/)
    assert.equal(
      result.steps.some((step) => step.key === "travel_depart"),
      false,
    )
  } finally {
    setProviderFetchForTesting(previous)
  }
})
