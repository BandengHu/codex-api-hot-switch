import "server-only"

import assert from "node:assert/strict"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { isRefreshTokenDead, WorkbuddyCnRefreshError } from "./cn-oauth"
import { formatShanghaiDay } from "./workbuddy-time"
import { parseWorkbuddyAccount } from "./account"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** 上海时区某天的 10:00（UTC+8），用作“当天”的稳定锚点。 */
function shanghaiNoon(dayOffset = 0) {
  const base = Date.UTC(2026, 10, 20, 2, 0, 0) // 2026-11-20 10:00 CST
  return base + dayOffset * DAY
}

function renewInputBase(expiresAt: number, lastRefreshTime?: number) {
  return {
    uid: "uid-daily",
    refreshToken: "rt",
    expiresAt,
    ...(lastRefreshTime === undefined ? {} : { lastRefreshTime }),
  }
}

test("每天续期一次：当天没续过就续，不看剩余寿命", async () => {
  const { shouldRenewCnAccount, resetRenewalStateForTesting } = await import(
    "./cn-token-renewal"
  )
  resetRenewalStateForTesting()
  const now = shanghaiNoon()
  // 还剩 20 天也照续——口径是“每天一次”，不是“临期才续”。
  assert.equal(shouldRenewCnAccount(renewInputBase(now + 20 * DAY), now), true)
  // 已过期更要续。
  assert.equal(shouldRenewCnAccount(renewInputBase(now - HOUR), now), true)
})

test("当天已续过（凭据文件 lastRefreshTime）就不再续，跨天恢复", async () => {
  const { shouldRenewCnAccount, resetRenewalStateForTesting } = await import(
    "./cn-token-renewal"
  )
  resetRenewalStateForTesting()
  const now = shanghaiNoon()
  const sameDay = renewInputBase(now + 28 * DAY, now - 2 * HOUR)
  assert.equal(shouldRenewCnAccount(sameDay, now), false)
  assert.equal(formatShanghaiDay(new Date(sameDay.lastRefreshTime!)), formatShanghaiDay(new Date(now)))
  // 第二天同一时刻应恢复续期。
  assert.equal(shouldRenewCnAccount(sameDay, now + DAY), true)
})

test("续期成功后当天不再重复，失败在冷却窗口内不重试、过窗口可重试", async () => {
  const {
    markRenewAttempt,
    shouldRenewCnAccount,
    resetRenewalStateForTesting,
  } = await import("./cn-token-renewal")
  resetRenewalStateForTesting()
  const now = shanghaiNoon()
  const input = renewInputBase(now + 27 * DAY)

  markRenewAttempt(input.uid, true, now)
  assert.equal(shouldRenewCnAccount(input, now + HOUR), false)

  resetRenewalStateForTesting()
  markRenewAttempt(input.uid, false, now)
  assert.equal(shouldRenewCnAccount(input, now + 60 * 1000), false)
  assert.equal(shouldRenewCnAccount(input, now + 11 * 60 * 1000), true)
})

test("没有 refreshToken 或 expiresAt 未知时不续期", async () => {
  const { shouldRenewCnAccount, resetRenewalStateForTesting } = await import(
    "./cn-token-renewal"
  )
  resetRenewalStateForTesting()
  const now = shanghaiNoon()
  assert.equal(
    shouldRenewCnAccount({ uid: "u", refreshToken: "  ", expiresAt: now + DAY }, now),
    false,
  )
  assert.equal(
    shouldRenewCnAccount({ uid: "u", refreshToken: "rt", expiresAt: 0 }, now),
    false,
  )
})

test("isRefreshTokenDead 只为上游判死的 token 返回 true", () => {
  // 实测文案：已失效的 refreshToken 会返回 invalid_grant
  assert.equal(isRefreshTokenDead("12153:refresh token failed:400 Bad Request: invalid_grant: Token is not active"), true)
  assert.equal(isRefreshTokenDead("12153:refresh token is invalid"), true)
  // 网络抖动 / 格式错误不该被判死，否则会逼用户白重登
  assert.equal(isRefreshTokenDead("刷新登录态失败：请求超时"), false)
  assert.equal(isRefreshTokenDead("12153:refresh token failed:10000:token format error"), false)
})

test("WorkbuddyCnRefreshError 携带 deadToken 标记", () => {
  const dead = new WorkbuddyCnRefreshError("invalid_grant: Token is not active", true)
  assert.equal(dead.deadToken, true)
  assert.equal(dead.name, "WorkbuddyCnRefreshError")
  const transient = new WorkbuddyCnRefreshError("请求超时")
  assert.equal(transient.deadToken, false)
})

test("allowExpired 能解析过期凭据，严格模式仍抛过期错误", async () => {
  const dir = join(tmpdir(), `switchgate-cn-renewal-${process.pid}-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  try {
    const raw = JSON.stringify({
      account: { uid: "expired-uid", nickname: "过期号" },
      auth: {
        accessToken: "at-expired",
        refreshToken: "rt-expired",
        domain: "www.codebuddy.cn",
        expiresAt: Date.now() - 2 * HOUR,
      },
    })
    await assert.rejects(
      () => parseWorkbuddyAccount(raw, "<test>"),
      /登录态已过期/,
    )
    const relaxed = await parseWorkbuddyAccount(raw, "<test>", { allowExpired: true })
    assert.equal(relaxed.uid, "expired-uid")
    assert.equal(relaxed.refreshToken, "rt-expired")
    assert.ok(relaxed.expiresAt < Date.now())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("refreshCnTokens 用 x-refresh-token 头刷新，并返回轮换后的新 token", async () => {
  const { refreshCnTokens } = await import("./cn-oauth")
  const { setProviderFetchForTesting } = await import(
    "@/lib/server/proxy/provider-fetch"
  )
  const seen: Array<{ url: string; refreshHeader: string; body: string }> = []
  const previous = setProviderFetchForTesting(async (input, init) => {
    const headers = new Headers(init?.headers)
    seen.push({
      url: String(input),
      refreshHeader: headers.get("x-refresh-token") || "",
      body: typeof init?.body === "string" ? init.body : "",
    })
    return Response.json({
      code: 0,
      msg: "OK",
      data: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresIn: 2419200,
        domain: "www.codebuddy.cn",
      },
    })
  })
  try {
    const tokens = await refreshCnTokens("old-refresh")
    assert.equal(tokens.accessToken, "new-access")
    assert.equal(tokens.refreshToken, "new-refresh")
    assert.equal(tokens.expiresIn, 2419200)
    assert.equal(tokens.domain, "www.codebuddy.cn")
    assert.equal(seen.length, 1)
    // refreshToken 必须在 header 里：放 body 上游会返回「refreshToken is empty」
    assert.equal(seen[0].refreshHeader, "old-refresh")
    assert.equal(seen[0].url, "https://copilot.tencent.com/v2/plugin/auth/token/refresh")
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("refreshCnTokens 把已失效 token 标记为 deadToken", async () => {
  const { refreshCnTokens } = await import("./cn-oauth")
  const { setProviderFetchForTesting } = await import(
    "@/lib/server/proxy/provider-fetch"
  )
  const previous = setProviderFetchForTesting(async () =>
    Response.json(
      {
        code: 12153,
        msg: "12153:refresh token failed:400 Bad Request: invalid_grant: Token is not active",
      },
      { status: 401 },
    ),
  )
  try {
    await assert.rejects(
      () => refreshCnTokens("dead-refresh"),
      (error) => {
        assert.ok(error instanceof WorkbuddyCnRefreshError)
        assert.equal(error.deadToken, true)
        return true
      },
    )
  } finally {
    setProviderFetchForTesting(previous)
  }
})

test("renewCnPoolAccount 刷新后把新 token 原子写回凭据文件", async () => {
  const { renewCnPoolAccount } = await import("./cn-token-renewal")
  const { setProviderFetchForTesting } = await import(
    "@/lib/server/proxy/provider-fetch"
  )
  const dir = join(tmpdir(), `switchgate-cn-writeback-${process.pid}-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, "uid.json")
  const original = JSON.stringify({
    account: { uid: "uid", nickname: "号" },
    auth: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      domain: "www.codebuddy.cn",
      expiresAt: Date.now() - HOUR,
    },
  })
  await writeFile(filePath, original, "utf8")
  const previous = setProviderFetchForTesting(async () =>
    Response.json({
      code: 0,
      data: {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresIn: 2419200,
        domain: "www.codebuddy.cn",
      },
    }),
  )
  try {
    const before = Date.now()
    const renewed = await renewCnPoolAccount({
      uid: "uid",
      filePath,
      raw: original,
      account: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - HOUR,
        domain: "www.codebuddy.cn",
        uid: "uid",
        nickname: "号",
        uin: "",
      },
    })
    assert.equal(renewed.accessToken, "new-access")
    assert.equal(renewed.refreshToken, "new-refresh")
    assert.ok(renewed.expiresAt > before + 27 * 24 * HOUR)

    // 落盘必须换新：refreshToken 被上游轮换，旧值下次就失效
    const saved = JSON.parse(await readFile(filePath, "utf8")) as {
      account: Record<string, unknown>
      auth: Record<string, unknown>
    }
    assert.equal(saved.auth.accessToken, "new-access")
    assert.equal(saved.auth.refreshToken, "new-refresh")
    assert.equal(saved.account.uid, "uid")
    assert.equal(typeof saved.auth.lastRefreshTime, "number")
  } finally {
    setProviderFetchForTesting(previous)
    await rm(dir, { recursive: true, force: true })
  }
})

