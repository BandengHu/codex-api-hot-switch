import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { parseGlobalCredential } from "./global-account"
import {
  buildGlobalCredentialFile,
  GLOBAL_OAUTH_PENDING_CODE,
  GLOBAL_WORKBUDDY_ORIGIN,
  GLOBAL_WORKBUDDY_PLATFORM,
  isSafeGlobalUid,
} from "./global-oauth"
import { activeGlobalUidOf, type GlobalPoolState } from "./global-pool-store"

test("国际版固定打国际站，且设备流平台标识与国内站不同", () => {
  assert.equal(GLOBAL_WORKBUDDY_ORIGIN, "https://www.workbuddy.ai")
  // 国内站是 CLI，国际站是 workbuddy-ai；写错会被上游拒。
  assert.equal(GLOBAL_WORKBUDDY_PLATFORM, "workbuddy-ai")
  assert.equal(GLOBAL_OAUTH_PENDING_CODE, 11217)
})

test("uid 安全校验拦下路径穿越与超长值", () => {
  assert.equal(isSafeGlobalUid("34c8ff88-51dc-4e49-b39c-fd811b4954e1"), true)
  assert.equal(isSafeGlobalUid("abc_DEF-123"), true)
  assert.equal(isSafeGlobalUid(""), false)
  assert.equal(isSafeGlobalUid("../../evil"), false)
  assert.equal(isSafeGlobalUid("a/b"), false)
  assert.equal(isSafeGlobalUid("命名"), false)
  assert.equal(isSafeGlobalUid("a".repeat(65)), false)
})

test("授权登录写出的凭据可被国际版解析器读回", async () => {
  const raw = buildGlobalCredentialFile(
    {
      accessToken: "at-global",
      refreshToken: "rt-global",
      expiresIn: 3600,
      domain: "www.workbuddy.ai",
    },
    { uid: "uid-global", nickname: "化风" },
  )
  const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
  assert.equal(parsed.auth.accessToken, "at-global")
  assert.equal(parsed.auth.refreshToken, "rt-global")
  assert.equal(parsed.auth.domain, "www.workbuddy.ai")
  assert.equal(parsed.account.uid, "uid-global")
  assert.equal(parsed.account.nickname, "化风")
  assert.equal(raw.endsWith("\n"), true)

  // refresh: false —— 只做静态解析，不打上游。
  const account = await parseGlobalCredential(raw, "<test>", { refresh: false })
  assert.equal(account.account.uid, "uid-global")
  assert.equal(account.account.accessToken, "at-global")
  assert.equal(account.account.domain, "www.workbuddy.ai")
  assert.equal(account.refreshed, false)
  assert.equal(account.raw, raw)
})

test("WorkBuddy2API 的 headless 凭据形状可直接导入", async () => {
  const raw = JSON.stringify({
    account: { uid: "wb2api-user" },
    auth: {
      accessToken: "at",
      refreshToken: "rt",
      domain: "www.workbuddy.ai",
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  })
  const parsed = await parseGlobalCredential(raw, "<workbuddy2api-auth>", {
    refresh: false,
  })
  assert.equal(parsed.account.uid, "wb2api-user")
  assert.equal(parsed.account.refreshToken, "rt")
})

test("域缺失时按国际站口径回落，不会漏成国内域", async () => {
  const parsed = await parseGlobalCredential(
    JSON.stringify({
      account: { uid: "u" },
      auth: { accessToken: "at", refreshToken: "", expiresAt: 0 },
    }),
    "<test>",
    { refresh: false },
  )
  assert.equal(parsed.account.domain, "www.workbuddy.ai")
})

test("没有 accessToken 的凭据明确报错，不静默返回空账号", async () => {
  await assert.rejects(
    parseGlobalCredential(JSON.stringify({ account: { uid: "u" }, auth: {} }), "<test>", {
      refresh: false,
    }),
    /没有 accessToken/,
  )
  await assert.rejects(parseGlobalCredential("not-json", "<test>"), /不是合法 JSON/)
})

function poolState(
  entries: Array<{ uid: string; disabled?: boolean }>,
  activeUid?: string,
): GlobalPoolState {
  return {
    version: 1,
    entries: entries.map((entry) => ({
      uid: entry.uid,
      nickname: "",
      domain: "www.workbuddy.ai",
      disabled: entry.disabled ?? false,
    })),
    ...(activeUid ? { activeUid } : {}),
  }
}

test("国际版生效账号：显式指定优先，未指定回落第一个可用账号", () => {
  assert.equal(
    activeGlobalUidOf(poolState([{ uid: "a" }, { uid: "b" }], "b")),
    "b",
  )
  assert.equal(activeGlobalUidOf(poolState([{ uid: "a" }, { uid: "b" }])), "a")
})

test("指定的账号被移除或禁用时回落，不把请求打到坏账号上", () => {
  // 指定的账号已不在池里。
  assert.equal(
    activeGlobalUidOf(poolState([{ uid: "a" }, { uid: "b" }], "gone")),
    "a",
  )
  // 指定的账号被禁用。
  assert.equal(
    activeGlobalUidOf(poolState([{ uid: "a", disabled: true }, { uid: "b" }], "a")),
    "b",
  )
  // 第一个账号被禁用时跳过它。
  assert.equal(
    activeGlobalUidOf(poolState([{ uid: "a", disabled: true }, { uid: "b" }])),
    "b",
  )
})

test("池里没有可用账号时明确报错，而不是悄悄用空凭据打上游", () => {
  assert.throws(() => activeGlobalUidOf(poolState([])), /没有可用账号/)
  assert.throws(
    () => activeGlobalUidOf(poolState([{ uid: "a", disabled: true }])),
    /没有可用账号/,
  )
})

test("持久封禁账号即使未禁用也不会被选为生效账号", () => {
  const state = poolState([{ uid: "a" }, { uid: "b" }], "a")
  state.accountBans = {
    a: {
      code: 11140,
      message: "账号存在异常行为，已被限制使用",
      detectedAt: "2026-10-29T08:00:00.000Z",
    },
  }
  assert.equal(activeGlobalUidOf(state), "b")
})
