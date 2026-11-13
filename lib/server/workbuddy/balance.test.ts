import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { setProviderFetchForTesting } from "@/lib/server/proxy/provider-fetch"
import type { WorkbuddyAccount } from "./account"
import { fetchBalance } from "./task-api"

const account = {
  accessToken: "balance-token",
  refreshToken: "",
  expiresAt: 0,
  domain: "www.codebuddy.cn",
  uid: "balance-uid",
  nickname: "",
  uin: "",
} satisfies WorkbuddyAccount

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

test("国内余额以 summary 为累计口径，明细只补包数", async () => {
  const paths: string[] = []
  const previous = setProviderFetchForTesting(async (input) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    if (path.includes("get-user-resource-summary")) {
      return response({
        code: 0,
        data: {
          Packages: [
            { CycleTotalCapacity: 300, CycleRemainCapacity: 300, CycleUsedCapacity: 0 },
            { CycleTotalCapacity: 300, CycleRemainCapacity: 0, CycleUsedCapacity: 300 },
          ],
        },
      })
    }
    return response({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [{ CycleCapacitySize: 300, CycleCapacityRemain: 300 }],
          },
        },
      },
    })
  })
  try {
    assert.deepEqual(await fetchBalance(account), {
      remain: 300,
      used: 300,
      size: 600,
      packs: 1,
    })
    assert.deepEqual(paths.sort(), [
      "/v2/billing/meter/get-user-resource",
      "/billing/meter/get-user-resource-summary",
    ].sort())
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("summary 请求失败时国内余额回退明细，仍排除历史包漏算", async () => {
  const previous = setProviderFetchForTesting(async (input) => {
    const path = new URL(String(input)).pathname
    if (path.includes("get-user-resource-summary")) {
      return response({ code: 500, msg: "summary unavailable" }, 500)
    }
    return response({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              { CapacitySize: 300, CapacityRemain: 0, CapacityUsed: 300 },
              { CapacitySize: 300, CapacityRemain: 120, CapacityUsed: 180 },
            ],
          },
        },
      },
    })
  })
  try {
    assert.deepEqual(await fetchBalance(account), {
      remain: 120,
      used: 480,
      size: 600,
      packs: 2,
    })
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("summary 缺容量字段时回退旧明细", async () => {
  const previous = setProviderFetchForTesting(async (input) => {
    const path = new URL(String(input)).pathname
    if (path.includes("get-user-resource-summary")) {
      return response({ code: 0, data: { Packages: [{ PackageCode: "legacy" }] } })
    }
    return response({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [{ CycleCapacitySize: 300, CycleCapacityRemain: 120 }],
          },
        },
      },
    })
  })
  try {
    assert.deepEqual(await fetchBalance(account), {
      remain: 120,
      used: 180,
      size: 300,
      packs: 1,
    })
  } finally {
    setProviderFetchForTesting(previous)
  }
})
