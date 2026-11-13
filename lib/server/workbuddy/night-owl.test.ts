import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { setProviderFetchForTesting } from "@/lib/server/proxy/provider-fetch"
import type { WorkbuddyAccount } from "./account"
import { nightOwlNeedsReport, runNightOwl } from "./night-owl"

const account = {
  accessToken: "night-token",
  refreshToken: "",
  expiresAt: 0,
  domain: "www.codebuddy.cn",
  uid: "night-uid",
  nickname: "",
  uin: "",
} satisfies WorkbuddyAccount

test("夜猫子只有在未领取、未达标时才上报", () => {
  assert.equal(nightOwlNeedsReport({
    accepted: true,
    claimed: false,
    current: 0,
    target: 3,
    claimable: false,
  }), true)
  assert.equal(nightOwlNeedsReport({
    accepted: true,
    claimed: false,
    current: 3,
    target: 3,
    claimable: true,
  }), false)
  assert.equal(nightOwlNeedsReport({
    accepted: true,
    claimed: true,
    current: 3,
    target: 3,
    claimable: false,
  }), false)
})

test("窗口外不请求上游", async () => {
  let calls = 0
  const previous = setProviderFetchForTesting(async () => {
    calls += 1
    return Response.json({ code: 0, data: {} })
  })
  try {
    const result = await runNightOwl(account, new Date("2026-11-13T04:00:00Z"))
    assert.equal(result.status, "skipped")
    assert.equal(result.windowOpen, false)
    assert.equal(calls, 0)
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("夜间事件使用 mode=night、GLM-5.2 模型，accept 后只上报一次", async () => {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = []
  let taskReads = 0
  let taskAccepted = false
  const previous = setProviderFetchForTesting(async (input, init) => {
    const path = new URL(String(input)).pathname
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ path, method: init?.method, body })
    if (path.endsWith("/v2/activity/growth/tasks/accept")) {
      taskAccepted = true
      return Response.json({ code: 0, data: {} })
    }
    if (path.endsWith("/v2/activity/growth/tasks")) {
      taskReads += 1
      return Response.json({
        code: 0,
        data: {
          tasks: [{
            task_code: "black_cat",
            accept_status: taskAccepted ? "accepted" : "not_accepted",
            target: 3,
            current: taskReads > 2 ? 1 : 0,
          }],
        },
      })
    }
    if (path.endsWith("/v2/report")) {
      return Response.json({ code: 0, data: {} })
    }
    throw new Error(`unexpected request ${path}`)
  })
  try {
    const result = await runNightOwl(account, new Date("2026-11-13T15:30:00Z"))
    assert.equal(result.status, "done")
    const accept = calls.find((call) => call.path.endsWith("/tasks/accept"))
    assert.deepEqual(accept?.body, { task_codes: ["black_cat"] })
    const reports = calls.filter((call) => call.path.endsWith("/v2/report"))
    assert.equal(reports.length, 1)
    const event = (reports[0].body as Array<Record<string, unknown>>)[0]
    assert.equal(event.eventCode, "chat_request_send")
    assert.equal(event.mode, "night")
    assert.equal(event.requestModelId, "glm-5.2")
    assert.equal(event.requestModelName, "GLM-5.2")
    assert.equal(event.userId, account.uid)
  } finally {
    setProviderFetchForTesting(previous)
  }
})
