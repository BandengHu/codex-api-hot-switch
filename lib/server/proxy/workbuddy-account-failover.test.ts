import assert from "node:assert/strict"
import { mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { resolvePrimaryProvider } from "@/lib/provider-endpoints"
import type { Provider } from "@/lib/types"
import { workbuddyGlobalProviderTemplate } from "@/lib/workbuddy-provider"
import { WorkbuddyRateLimitError } from "@/lib/server/workbuddy/rate-limit"
import { WorkbuddyAccountBanError } from "@/lib/server/workbuddy/account-ban"

const MESSAGE =
  "您的使用量已超出频率限制，将在 2026-10-30 10:43:32 UTC+8 重置，您也可以切换其他模型继续使用。"
const dataDir = join(
  tmpdir(),
  `switchgate-workbuddy-rate-limit-${process.pid}-${Date.now()}`,
)
process.env.CODEX_HOT_SWITCH_DATA_DIR = dataDir

let fetchWithWorkbuddyAccountFailover:
  typeof import("./workbuddy-account-failover").fetchWithWorkbuddyAccountFailover
let setProviderFetchForTesting:
  typeof import("./provider-fetch").setProviderFetchForTesting
let importGlobalAccount:
  typeof import("@/lib/server/workbuddy/global-pool-store").importGlobalAccount
let readGlobalPoolState:
  typeof import("@/lib/server/workbuddy/global-pool-store").readGlobalPoolState
let setActiveGlobalPoolAccount:
  typeof import("@/lib/server/workbuddy/global-pool-store").setActiveGlobalPoolAccount
let withWorkbuddyTargetCredentials:
  typeof import("@/lib/server/workbuddy/upstream").withWorkbuddyTargetCredentials

test.before(async () => {
  await mkdir(dataDir, { recursive: true })
  ;({
    fetchWithWorkbuddyAccountFailover,
  } = await import("./workbuddy-account-failover"))
  ;({ setProviderFetchForTesting } = await import("./provider-fetch"))
  ;({
    importGlobalAccount,
    readGlobalPoolState,
    setActiveGlobalPoolAccount,
  } = await import("@/lib/server/workbuddy/global-pool-store"))
  ;({ withWorkbuddyTargetCredentials } = await import(
    "@/lib/server/workbuddy/upstream"
  ))
})

test.after(async () => {
  delete process.env.CODEX_HOT_SWITCH_DATA_DIR
  await rm(dataDir, { recursive: true, force: true })
})

function credential(uid: string, token: string) {
  return JSON.stringify({
    account: { uid, nickname: uid },
    auth: {
      accessToken: token,
      refreshToken: "",
      domain: "www.workbuddy.ai",
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  })
}

function target(provider: Provider) {
  return {
    provider: resolvePrimaryProvider(provider),
    modelId: "glm-5.3",
    requestedModel: "glm-5.3",
    reasoning: "off" as const,
    paused: false,
  }
}

async function prepareAccounts(firstUid: string, secondUid?: string) {
  await importGlobalAccount(credential(firstUid, `token-${firstUid}`))
  if (secondUid) {
    await importGlobalAccount(credential(secondUid, `token-${secondUid}`))
  }
  await setActiveGlobalPoolAccount(firstUid)
  const provider = workbuddyGlobalProviderTemplate()
  return {
    provider,
    target: await withWorkbuddyTargetCredentials(target(provider)),
  }
}

function accountHeaders(init: RequestInit | undefined) {
  return new Headers(init?.headers)
}

function limitedStream() {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: MESSAGE } }] })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  )
}

function splitLimitedStream() {
  const chunks = [
    "您的使用量已超出",
    "频率限制，将在 2026-10-30 ",
    "10:43:32 UTC+8 重置，",
    "您也可以切换其他模型继续使用。",
  ]
  return new Response(
    chunks
      .map(
        (content) =>
          `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

const SUCCESS_STREAM = [
  "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\n",
  "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
  "data: [DONE]\n\n",
].join("")

test("WorkBuddy account failover", async (t) => {
  await t.test("a WorkBuddy rate limit freezes account A and retries with account B credentials", async () => {
  const prepared = await prepareAccounts("account-a", "account-b")
  const seen: Array<{
    authorization: string
    uid: string
    domain: string
    origin: string
    referer: string
  }> = []
  const previousFetch = setProviderFetchForTesting(async (_input, init) => {
    const headers = accountHeaders(init)
    seen.push({
      authorization: headers.get("authorization") || "",
      uid: headers.get("x-user-id") || "",
      domain: headers.get("x-domain") || "",
      origin: headers.get("origin") || "",
      referer: headers.get("referer") || "",
    })
    if (headers.get("authorization") === "Bearer token-account-a") {
      return limitedStream()
    }
    return new Response(SUCCESS_STREAM, {
      headers: { "content-type": "text/event-stream" },
    })
  })

  try {
    const attemptedUids: string[] = []
    const result = await fetchWithWorkbuddyAccountFailover({
      target: prepared.target,
      path: "v1/chat/completions",
      body: {
        model: "glm-5.3",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      requestIsStream: true,
      capacityRetryEnabled: false,
      attemptedUids,
    })

    assert.deepEqual(
      seen.map(({ authorization, uid }) => ({ authorization, uid })),
      [
        {
          authorization: "Bearer token-account-a",
          uid: "account-a",
        },
        {
          authorization: "Bearer token-account-b",
          uid: "account-b",
        },
      ],
    )
    for (const headers of seen) {
      assert.equal(headers.domain, "www.workbuddy.ai")
      assert.equal(headers.origin, "https://www.workbuddy.ai")
      assert.equal(headers.referer, "https://www.workbuddy.ai/")
    }
    assert.deepEqual(result.target.workbuddyAccount, {
      uid: "account-b",
      realm: "global",
    })
    assert.equal(await result.response.text(), SUCCESS_STREAM)
    assert.deepEqual(attemptedUids, ["account-a"])

    const pool = await readGlobalPoolState()
    assert.equal(pool.activeUid, "account-b")
    assert.equal(pool.rateLimits?.["account-a"]?.message, MESSAGE)
  } finally {
    setProviderFetchForTesting(previousFetch)
  }
  })

  await t.test("all limited accounts stop immediately and preserve the latest 429 message", async () => {
  await rm(join(dataDir, "workbuddy-global-pool"), {
    recursive: true,
    force: true,
  })
  const prepared = await prepareAccounts("only-account")
  let calls = 0
  const previousFetch = setProviderFetchForTesting(async () => {
    calls += 1
    return limitedStream()
  })

  try {
    await assert.rejects(
      () =>
        fetchWithWorkbuddyAccountFailover({
          target: prepared.target,
          path: "v1/chat/completions",
          body: {
            model: "glm-5.3",
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          },
          requestIsStream: true,
          capacityRetryEnabled: false,
        }),
      (error) => {
        assert.ok(
          error instanceof WorkbuddyRateLimitError,
          `expected WorkbuddyRateLimitError, got ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        )
        assert.equal(error.status, 429)
        assert.match(error.message, new RegExp(MESSAGE.slice(0, 20)))
        return true
      },
    )
    assert.equal(calls, 1)
  } finally {
    setProviderFetchForTesting(previousFetch)
  }
  })

  await t.test("already attempted accounts cannot be selected again", async () => {
    await rm(join(dataDir, "workbuddy-global-pool"), {
      recursive: true,
      force: true,
    })
    const prepared = await prepareAccounts("loop-account-a", "loop-account-b")
    const previousFetch = setProviderFetchForTesting(async (_input, init) => {
      return accountHeaders(init).get("authorization") === "Bearer token-loop-account-a"
        ? limitedStream()
        : Response.json({ error: { message: "unexpected retry" } }, { status: 500 })
    })
    try {
      await assert.rejects(
        fetchWithWorkbuddyAccountFailover({
          target: prepared.target,
          path: "v1/chat/completions",
          body: { model: "glm-5.3", stream: true },
          requestIsStream: true,
          capacityRetryEnabled: false,
          attemptedUids: ["loop-account-b"],
        }),
        WorkbuddyRateLimitError,
      )
    } finally {
      setProviderFetchForTesting(previousFetch)
    }
  })

  await t.test("a split WorkBuddy rate limit freezes account A and retries with account B", async () => {
  await rm(join(dataDir, "workbuddy-global-pool"), {
    recursive: true,
    force: true,
  })
  const prepared = await prepareAccounts("split-account-a", "split-account-b")
  const seen: string[] = []
  const previousFetch = setProviderFetchForTesting(async (_input, init) => {
    const authorization = accountHeaders(init).get("authorization") || ""
    seen.push(authorization)
    if (authorization === "Bearer token-split-account-a") {
      return splitLimitedStream()
    }
    return new Response(SUCCESS_STREAM, {
      headers: { "content-type": "text/event-stream" },
    })
  })

  try {
    const result = await fetchWithWorkbuddyAccountFailover({
      target: prepared.target,
      path: "v1/chat/completions",
      body: {
        model: "glm-5.3",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      requestIsStream: true,
      capacityRetryEnabled: false,
    })
    assert.deepEqual(seen, [
      "Bearer token-split-account-a",
      "Bearer token-split-account-b",
    ])
    assert.equal(await result.response.text(), SUCCESS_STREAM)
    const pool = await readGlobalPoolState()
    assert.equal(pool.activeUid, "split-account-b")
    assert.equal(pool.rateLimits?.["split-account-a"]?.message, MESSAGE)
  } finally {
    setProviderFetchForTesting(previousFetch)
  }
  })

  await t.test("a generic 429 does not freeze a WorkBuddy account or rotate", async () => {
  await rm(join(dataDir, "workbuddy-global-pool"), {
    recursive: true,
    force: true,
  })
  const prepared = await prepareAccounts("generic-account", "unused-account")
  let calls = 0
  const previousFetch = setProviderFetchForTesting(async () => {
    calls += 1
    return Response.json(
      { error: { message: "too many requests", type: "rate_limit_error" } },
      { status: 429 },
    )
  })

  try {
    const result = await fetchWithWorkbuddyAccountFailover({
      target: prepared.target,
      path: "v1/chat/completions",
      body: {
        model: "glm-5.3",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      },
      requestIsStream: true,
      capacityRetryEnabled: false,
    })
    assert.equal(result.response.status, 429)
    assert.equal(calls, 1)
    const pool = await readGlobalPoolState()
    assert.equal(pool.activeUid, "generic-account")
    assert.equal(pool.rateLimits, undefined)
  } finally {
    setProviderFetchForTesting(previousFetch)
  }
  })

  await t.test("11140 persists the ban and never rotates to another account", async () => {
    await rm(join(dataDir, "workbuddy-global-pool"), {
      recursive: true,
      force: true,
    })
    const prepared = await prepareAccounts("banned-account", "must-not-run")
    let calls = 0
    const previousFetch = setProviderFetchForTesting(async () => {
      calls += 1
      return Response.json(
        {
          code: 0,
          data: {
            error: {
              code: 11140,
              message: "账号存在异常行为，已被限制使用",
            },
          },
        },
        { status: 403 },
      )
    })

    try {
      await assert.rejects(
        () =>
          fetchWithWorkbuddyAccountFailover({
            target: prepared.target,
            path: "v1/chat/completions",
            body: {
              model: "glm-5.3",
              stream: true,
              messages: [{ role: "user", content: "hello" }],
            },
            requestIsStream: true,
            capacityRetryEnabled: false,
          }),
        (error) => {
          assert.ok(error instanceof WorkbuddyAccountBanError)
          assert.equal(error.status, 403)
          assert.equal(error.kind, "auth")
          assert.equal(error.ban.code, 11140)
          return true
        },
      )
      assert.equal(calls, 1)
      const pool = await readGlobalPoolState()
      assert.equal(pool.activeUid, undefined)
      assert.equal(pool.accountBans?.["banned-account"]?.code, 11140)
      assert.equal(pool.accountBans?.["must-not-run"], undefined)
    } finally {
      setProviderFetchForTesting(previousFetch)
    }
  })

  await t.test("a persisted ban stops before provider fetch with a typed 403", async () => {
    await rm(join(dataDir, "workbuddy-global-pool"), {
      recursive: true,
      force: true,
    })
    const prepared = await prepareAccounts("restart-banned-account", "must-not-run")
    const { banGlobalPoolAccount } = await import(
      "@/lib/server/workbuddy/global-pool-store"
    )
    const detectedAt = new Date("2026-11-13T08:00:00.000Z")
    await banGlobalPoolAccount("restart-banned-account", {
      code: 11140,
      message: "账号存在异常行为，已被限制使用",
      detectedAt: detectedAt.toISOString(),
    })
    let calls = 0
    const previousFetch = setProviderFetchForTesting(async () => {
      calls += 1
      return new Response(SUCCESS_STREAM, {
        headers: { "content-type": "text/event-stream" },
      })
    })

    try {
      await assert.rejects(
        () =>
          fetchWithWorkbuddyAccountFailover({
            target: prepared.target,
            path: "v1/chat/completions",
            body: {
              model: "glm-5.3",
              stream: true,
              messages: [{ role: "user", content: "hello" }],
            },
            requestIsStream: true,
            capacityRetryEnabled: false,
          }),
        (error) => {
          assert.ok(error instanceof WorkbuddyAccountBanError)
          assert.equal(error.status, 403)
          assert.equal(error.kind, "auth")
          assert.equal(error.ban.code, 11140)
          assert.equal(error.ban.detectedAt, detectedAt.toISOString())
          return true
        },
      )
      assert.equal(calls, 0)
    } finally {
      setProviderFetchForTesting(previousFetch)
    }
  })
})
