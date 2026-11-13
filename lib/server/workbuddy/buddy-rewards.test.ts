import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { setProviderFetchForTesting } from "@/lib/server/proxy/provider-fetch"
import type { WorkbuddyAccount } from "./account"
import {
  buddyOpenCount,
  fetchBuddyQuota,
  openBuddyBoxes,
  parseBuddyQuota,
} from "./buddy-rewards"

const account = {
  accessToken: "buddy-token",
  refreshToken: "",
  expiresAt: 0,
  domain: "www.codebuddy.cn",
  uid: "buddy-uid",
  nickname: "",
  uin: "",
} satisfies WorkbuddyAccount

test("Buddy 盲盒额度按官方字段解析，每次至少允许开 1 个", () => {
  assert.deepEqual(parseBuddyQuota({ affordable: "4", max_open_count: "2" }), {
    affordable: 4,
    maxOpenCount: 2,
  })
  assert.deepEqual(parseBuddyQuota({}), { affordable: 0, maxOpenCount: 1 })
  assert.equal(buddyOpenCount({ affordable: 4, maxOpenCount: 2 }), 2)
  assert.equal(buddyOpenCount({ affordable: 0, maxOpenCount: 2 }), 0)
})

test("Buddy 盲盒使用 v2 接口，能量不足时不请求 open", async () => {
  const calls: string[] = []
  const previous = setProviderFetchForTesting(async (input) => {
    calls.push(new URL(String(input)).pathname)
    return Response.json({
      code: 0,
      data: { affordable: 0, max_open_count: 3 },
    })
  })
  try {
    assert.equal(await openBuddyBoxes(account), undefined)
    assert.deepEqual(calls, ["/v2/activity/growth/buddy/quota"])
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("Buddy 盲盒按 affordable 和 max_open_count 取较小值", async () => {
  const calls: Array<{ path: string; body?: unknown }> = []
  const previous = setProviderFetchForTesting(async (input, init) => {
    const path = new URL(String(input)).pathname
    calls.push({
      path,
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    })
    if (path.endsWith("/quota")) {
      return Response.json({
        code: 0,
        data: { affordable: 5, max_open_count: 2 },
      })
    }
    return Response.json({
      code: 0,
      data: { buddies: ["猫咪学霸", "咖啡猫"] },
    })
  })
  try {
    const result = await openBuddyBoxes(account)
    assert.deepEqual(result, { count: 2, names: ["猫咪学霸", "咖啡猫"] })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].path, "/v2/activity/growth/buddy/quota")
    assert.equal(calls[1].path, "/v2/activity/growth/buddy/open")
    const body = calls[1].body as Record<string, unknown>
    assert.equal(body.count, 2)
    assert.match(String(body.client_token), /^[0-9a-f-]{36}$/)
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("Buddy 额度查询失败不会被当成零能量", async () => {
  const previous = setProviderFetchForTesting(async () => {
    throw new Error("network down")
  })
  try {
    await assert.rejects(fetchBuddyQuota(account), /network down/)
  } finally {
    setProviderFetchForTesting(previous)
  }
})
