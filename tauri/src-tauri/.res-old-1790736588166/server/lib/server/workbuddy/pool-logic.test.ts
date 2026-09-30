import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import type { WorkbuddyAccount } from "./account"
import {
 buildHeaders,
 MP_CLIENT_PRODUCT,
 realmBase,
 stableId,
 truncateStr,
 WorkbuddyTaskApiError,
} from "./api-client"
import { buildCredentialFile, isValidUid } from "./oauth"
import { isMpTaskCode } from "./task-api"
import { busyTaskAccounts, tryLockTaskAccount, unlockTaskAccount } from "./task-lock"
import { activeUidOf, LOCAL_POOL_UID, type WorkbuddyPoolState } from "./task-pool-store"
import { isAlreadyDoneError } from "./daily-api"

const CN_ACCOUNT: WorkbuddyAccount = {
 accessToken: "token-cn",
 refreshToken: "",
 expiresAt:0,
 domain: "www.codebuddy.cn",
 uid: "34c8ff88-51dc-4e49-b39c-fd811b4954e1",
 nickname: "",
 uin: "",
}

const GLOBAL_ACCOUNT: WorkbuddyAccount = { ...CN_ACCOUNT, domain: "www.workbuddy.ai" }

test("域路由：CN走 codebuddy/tencent三域，国际站三域同源", () => {
 const cn = realmBase(CN_ACCOUNT)
 assert.equal(cn.chat, "https://copilot.tencent.com")
 assert.equal(cn.billing, "https://www.codebuddy.cn")
 assert.equal(cn.web, "https://www.workbuddy.cn")

 const global = realmBase(GLOBAL_ACCOUNT)
 assert.equal(global.chat, "https://www.workbuddy.ai")
 assert.equal(global.billing, global.chat)
 assert.equal(global.web, global.chat)
})

test("令牌缺失（domain为空）按 CN口径，不会误判成国际站", () => {
 assert.equal(realmBase({ ...CN_ACCOUNT, domain: "" }).chat, "https://copilot.tencent.com")
})

test("出站头按指纹分族：桌面端三段式 UA，mp带小程序平台头", () => {
 const desktop = buildHeaders(CN_ACCOUNT, { method: "POST", fingerprint: "desktop" })
 assert.match(desktop["user-agent"], /^WorkBuddy\/[\d.]+ WorkBuddy\/[\d.]+ CLI\/[\d.]+$/)
 assert.equal(desktop["x-product"], "SaaS")
 assert.equal(desktop["x-domain"], "https://copilot.tencent.com")
 assert.equal(desktop["x-client-platform"], undefined)

 const mp = buildHeaders(CN_ACCOUNT, { method: "POST", fingerprint: "mp" })
 assert.equal(mp["x-client-product"], MP_CLIENT_PRODUCT)
 assert.equal(mp["x-client-platform"], "mp-weixin")
 assert.equal(mp["x-platform"], "wechatmp")

 const web = buildHeaders(CN_ACCOUNT, { method: "POST", fingerprint: "web" })
 assert.equal(web["x-client-platform"], "web")
 assert.equal(web.origin, "https://www.workbuddy.cn")
 assert.equal(web.referer, "https://www.workbuddy.cn/profile/growth-center")
})

test("mp口径显式覆盖平台头（growth任务要求 miniprogram）", () => {
 const headers = buildHeaders(CN_ACCOUNT, {
 method: "POST",
 fingerprint: "mp",
 platform: "miniprogram",
 })
 assert.equal(headers["x-client-platform"], "miniprogram")
})

test("鉴权头始终带 Bearer，且不把 token泄漏进其它字段", () => {
 const headers = buildHeaders(CN_ACCOUNT, { method: "GET" })
 assert.equal(headers.authorization, "Bearer token-cn")
 assert.equal(headers["x-user-id"], CN_ACCOUNT.uid)
})

test("稳定 id由 uid派生：同 uid恒定、异 uid不同", () => {
 const first = stableId("uid-a", "machine")
 assert.equal(first, stableId("uid-a", "machine"))
 assert.equal(first.length,36)
 assert.notEqual(first, stableId("uid-b", "machine"))
 assert.notEqual(first, stableId("uid-a", "session"))
})

test("uid安全校验拦下路径穿越与超长值", () => {
 assert.equal(isValidUid("34c8ff88-51dc-4e49-b39c-fd811b4954e1"), true)
 assert.equal(isValidUid("abc_DEF-123"), true)
 assert.equal(isValidUid(""), false)
 assert.equal(isValidUid("../../evil"), false)
 assert.equal(isValidUid("a/b"), false)
 assert.equal(isValidUid("a\\b"), false)
 assert.equal(isValidUid("命名"), false)
 assert.equal(isValidUid("a".repeat(65)), false)
})

test("授权凭据落盘格式可被桌面端解析器直接读回", async () => {
 const before = Date.now()
 const raw = buildCredentialFile(
 { accessToken: "at-1", refreshToken: "rt-1", expiresIn:3600, domain: "www.codebuddy.cn" },
 { uid: "uid-1", enterpriseId: "ent-1", nickname: "化风" },
 )
 const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
 assert.equal(parsed.auth.accessToken, "at-1")
 assert.equal(parsed.auth.refreshToken, "rt-1")
 assert.equal(parsed.auth.domain, "www.codebuddy.cn")
 assert.equal(parsed.account.uid, "uid-1")
 assert.equal(parsed.account.nickname, "化风")
 const expiresAt = Number(parsed.auth.expiresAt)
 assert.ok(expiresAt >= before +3600 *1000)
 assert.ok(expiresAt <= Date.now() +3600 *1000)
 assert.equal(raw.endsWith("\n"), true)
})

test("小程序专属任务码单独登记（决定回读/accept/领奖走 mp变体）", () => {
 assert.equal(isMpTaskCode("school_season"), true)
 assert.equal(isMpTaskCode(" Sequential_Tasks_3 "), true)
 assert.equal(isMpTaskCode("Sequential_Tasks_7"), true)
 assert.equal(isMpTaskCode("chat_5"), false)
 assert.equal(isMpTaskCode("RichMeow_Chat"), false)
})

test("错误文本截断保留可读前缀", () => {
assert.equal(truncateStr("short",10), "short")
assert.equal(truncateStr("0123456789abc",10), "0123456789…")
})

test("账号任务锁：同账号重复占用被拒，不同账号互不影响", () => {
 const uidA = "lock-test-a"
 const uidB = "lock-test-b"
 try {
 assert.equal(tryLockTaskAccount(uidA), true)
 assert.equal(tryLockTaskAccount(uidA), false)
 //不同账号并行照旧。
 assert.equal(tryLockTaskAccount(uidB), true)
 assert.deepEqual(busyTaskAccounts().sort(), [uidA, uidB].sort())
 } finally {
 unlockTaskAccount(uidA)
 unlockTaskAccount(uidB)
 }
 assert.equal(busyTaskAccounts().includes(uidA), false)
 //释放后可以重新占用（不会因为一次失败把账号永久锁死）。
 assert.equal(tryLockTaskAccount(uidA), true)
 unlockTaskAccount(uidA)
})

function poolState(active?: string, entries: Array<Partial<WorkbuddyPoolState["entries"][number]>> = []) {
 return {
 version:1 as const,
 entries: entries.map((entry) => ({
 uid: entry.uid ?? "u",
 nickname: entry.nickname ?? "",
 source: entry.source ?? ("file" as const),
 ...(entry.filePath ? { filePath: entry.filePath } : {}),
 disabled: entry.disabled ?? false,
 })),
 ...(active === undefined ? {} : { activeUid: active }),
 }
}

test("转发账号：没选过 / 选了本机 → 一律回落到 local", () => {
 assert.equal(activeUidOf(poolState()), LOCAL_POOL_UID)
 assert.equal(activeUidOf(poolState("")), LOCAL_POOL_UID)
 assert.equal(activeUidOf(poolState("  ")), LOCAL_POOL_UID)
 assert.equal(activeUidOf(poolState(LOCAL_POOL_UID)), LOCAL_POOL_UID)
})

test("转发账号：选中池内可用账号时生效（这是唯一的换号入口）", () => {
 const state = poolState("acc-2", [{ uid: "acc-1" }, { uid: "acc-2" }])
 assert.equal(activeUidOf(state), "acc-2")
})

test("转发账号：选中已被移除的账号时回落 local，不会卡在失效状态", () => {
 assert.equal(activeUidOf(poolState("gone", [{ uid: "acc-1" }])), LOCAL_POOL_UID)
})

test("转发账号：选中的账号被禁用后回落 local", () => {
 const state = poolState("acc-1", [{ uid: "acc-1", disabled: true }])
 assert.equal(activeUidOf(state), LOCAL_POOL_UID)
})

test("「已领过」幂等判定：只认上游分类错误，网络层错误不冒充成功", () => {
 // 实测原文：签到 / 礼包 / 补偿。
 assert.equal(
 isAlreadyDoneError(
 new WorkbuddyTaskApiError(
 '每日签到：HTTP 400 {"code":10001,"msg":"今天已签到，请明天再来"}',
 "",
 400,
 ),
 ),
 true,
 )
 assert.equal(
 isAlreadyDoneError(
 new WorkbuddyTaskApiError(
 '领取新手礼包：HTTP 400 {"code":10001,"msg":"每人限领一次，您已领取过无法重复领取"}',
 "",
 400,
 ),
 ),
 true,
 )
 assert.equal(
 isAlreadyDoneError(
 new WorkbuddyTaskApiError(
 '领取活动补偿：HTTP 400 {"code":10001,"msg":"补偿领取活动未开启或已过期"}',
 "",
 400,
 ),
 ),
 true,
 )

 // 网络层 / 解析层错误不得当成「已领」，否则当天实际没签到却被记成正常。
 assert.equal(isAlreadyDoneError(new Error("fetch failed")), false)
 assert.equal(isAlreadyDoneError(new WorkbuddyTaskApiError("查询余额：请求超时", undefined)), false)
 assert.equal(
 isAlreadyDoneError(new WorkbuddyTaskApiError("获取任务列表：响应不是 JSON对象", {})),
 false,
 )
})
