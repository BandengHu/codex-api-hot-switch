import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import type { WorkbuddyAccount } from "./account"
import {
  isRetryableWorkbuddyTaskError,
  taskFetch,
  WorkbuddyTaskApiError,
} from "./api-client"
import { drawLottery, fetchBuddy } from "./daily-api"

const account = {
  uid: "retry-test",
  nickname: "retry-test",
  accessToken: "test-token",
  domain: "https://copilot.tencent.com",
} as WorkbuddyAccount

test("WorkBuddy 请求只重试瞬时故障", () => {
  assert.equal(
    isRetryableWorkbuddyTaskError(new WorkbuddyTaskApiError("签到：fetch failed", undefined)),
    true,
  )
  assert.equal(
    isRetryableWorkbuddyTaskError(new WorkbuddyTaskApiError("签到：HTTP 503", "", 503)),
    true,
  )
  assert.equal(
    isRetryableWorkbuddyTaskError(new WorkbuddyTaskApiError("签到：HTTP 401", "", 401)),
    false,
  )
  assert.equal(
    isRetryableWorkbuddyTaskError(new WorkbuddyTaskApiError("签到失败：code=10001 已签到", {})),
    false,
  )
  assert.equal(
    isRetryableWorkbuddyTaskError(new WorkbuddyTaskApiError("签到失败：code=10002 fetch failed", { code: 10002 })),
    false,
  )
})

test("WorkBuddy 请求在 fetch failed 后重试并返回成功", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) throw new Error("fetch failed")
    return new Response(JSON.stringify({ code: 0, data: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  try {
    const result = await taskFetch(
      account,
      "https://example.com/daily-checkin",
      {
        method: "POST",
        body: {},
        retry: true,
        retryDelaysMs: [0],
      },
      "每日签到",
    )
    assert.equal(calls, 2)
    assert.deepEqual(result.data, { ok: true })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("WorkBuddy 请求对 429/503 重试，且达到次数上限即停止", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return new Response("busy", { status: calls === 1 ? 429 : 503 })
  }
  try {
    await assert.rejects(taskFetch(account, "https://example.com/status", {
      method: "GET", retry: true, retryDelaysMs: [0, 0],
    }, "查询"), (error: unknown) =>
      error instanceof WorkbuddyTaskApiError && error.status === 503)
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("WorkBuddy 请求对普通 4xx 和业务错误不重试", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  for (const response of [
    new Response("unauthorized", { status: 401 }),
    new Response("invalid", { status: 400 }),
    new Response(JSON.stringify({ code: 10001, msg: "已签到" }), { status: 200 }),
  ]) {
    globalThis.fetch = async () => {
      calls += 1
      return response
    }
    try {
      await assert.rejects(taskFetch(account, "https://example.com/checkin", {
        method: "POST", body: {}, retry: true, retryDelaysMs: [0, 0],
      }, "签到"), WorkbuddyTaskApiError)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
  assert.equal(calls, 3)
})

test("WorkBuddy 只读查询可重试，抽奖不会自动重放", async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    if (calls === 1) throw new Error("fetch failed")
    return new Response(JSON.stringify({ code: 0, data: { buddy: null } }), { status: 200 })
  }
  try {
    assert.equal(await fetchBuddy(account), undefined)
    assert.equal(calls, 2)
    globalThis.fetch = async () => {
      calls += 1
      throw new Error("fetch failed")
    }
    await assert.rejects(drawLottery(account), WorkbuddyTaskApiError)
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})
