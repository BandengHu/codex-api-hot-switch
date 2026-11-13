import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
 buildCredentialFile,
fetchOauthAccount,
isValidUid,
OAUTH_SESSION_TTL_MS,
pollOauthTokens,
startOauth,
} from "./oauth"
import { importPoolAccount, readPoolAccount } from "./task-pool-store"
import { fetchBalance } from "./task-api"
import { dailyCheckin, fetchCheckinActivityStatus } from "./daily-api"

/**
 *号池「浏览器授权登录」会话管理（进程内）。
 *
 *照搬 `workbuddy2api-panel`面板内嵌流程：start拿 state+authUrl并把 state记在进程内，
 *用户浏览器完成后前端轮询 poll；拿到 token即落盘号池（凭证文件形态与手工导入一致），
 *并顺带签到 +拉余额。
 *
 *与上游一致，**不做 PKCE**（workbuddy设备流由服务端签发 state）。
 */

interface LoginSession {
 createdAt: number
 authUrl: string
}

const sessions = new Map<string, LoginSession>()

function pruneSessions() {
 const now = Date.now()
 for (const [state, session] of sessions) {
 if (now - session.createdAt > OAUTH_SESSION_TTL_MS) sessions.delete(state)
 }
}

export interface LoginStartPayload {
 state: string
 url: string
 expiresInMs: number
}

/**发起授权：拿授权 URL并登记 state（复用本机账号做域判定）。 */
export async function beginPoolLogin(): Promise<LoginStartPayload> {
 pruneSessions()
 const account = await localAccountForRealm()
 const { state, authUrl } = await startOauth(account)
 sessions.set(state, { createdAt: Date.now(), authUrl })
 return { state, url: authUrl, expiresInMs: OAUTH_SESSION_TTL_MS }
}

export interface LoginPollDone {
 done: true
 uid: string
 nickname: string
 credits: number
 creditsTotal: number
 checkinMessage: string
}

export interface LoginPollPending {
 done: false
 message: string
}

/**轮询登录态：未完成返回 done=false；完成则落盘号池并返回账号信息。 */
export async function pollPoolLogin(state: string): Promise<LoginPollDone | LoginPollPending> {
 pruneSessions()
 const session = sessions.get(state)
 if (!session) {
 throw new Error("授权会话不存在或已过期，请重新发起登录")
 }

 const account = await localAccountForRealm()
 const tokens = await pollOauthTokens(account, state)
 if (!tokens) return { done: false, message: "等待浏览器完成登录" }

 const info = await fetchOauthAccount(account, state, tokens.accessToken).catch(() => ({
 uid: "",
 enterpriseId: "",
 nickname: "",
 }))
 if (!info.uid) {
 throw new Error("已登录但拿不到 uid（账号信息获取失败），请重试")
 }
 if (!isValidUid(info.uid)) {
 throw new Error("上游返回的 uid含非法字符，拒绝落盘（防路径穿越）")
 }

 const credential = {
...tokens,
//域跟随上游返回；缺失时回落本机账号的域（同 realm登录）。
domain: tokens.domain || account.domain,
}
 const raw = buildCredentialFile(credential, info)
 const entry = await importPoolAccount(raw)
 sessions.delete(state)

 let checkinMessage = ""
 let credits = -1
 let creditsTotal =0
 try {
 const saved = await readPoolAccount(entry.uid)
 const receipt = await dailyCheckin(saved).catch((error: unknown) => {
  // 登录不应因签到失败而失败；回执分类在每日任务里负责调度。
  checkinMessage = error instanceof Error ? error.message : String(error)
  return undefined
 })
 const checkinStatus = await fetchCheckinActivityStatus(saved).catch(() => undefined)
 if (checkinStatus?.todayCheckedIn) {
  checkinMessage = `官方状态确认今日已签到，今日累计 +${checkinStatus.todayCredit}分`
 } else if (checkinStatus) {
  checkinMessage = "签到请求已返回，但官方状态仍是今日未签到"
 } else if (receipt?.state === "checked") {
  checkinMessage = receipt.creditKnown
   ? `签到回执 +${receipt.credit}分，官方状态查询失败`
   : "签到回执成功，官方状态查询失败"
 } else if (receipt?.state === "already") {
  checkinMessage = "今天已签到"
 } else if (receipt) {
  checkinMessage = receipt.message || (receipt.state === "pending" ? "签到处理中" : "签到失败")
 }
 const balance = await fetchBalance(saved).catch(() => undefined)
 if (balance) {
 credits = balance.remain
 creditsTotal = balance.size
 }
 } catch {
 //签到 /余额失败不影响登录结果（凭证已落盘）。
 }

 return {
 done: true,
 uid: entry.uid,
 nickname: info.nickname,
 credits,
 creditsTotal,
 checkinMessage,
 }
}

/**
 *域判定载体：授权端点随 realm切换，但登录发生时号池里还没有这个账号，
 *所以用本机账号的域（无本机登录态时按 CN）。
 */
async function localAccountForRealm(): Promise<WorkbuddyAccount> {
 try {
 const { readWorkbuddyAccount } = await import("./account")
 return await readWorkbuddyAccount()
 } catch {
 return {
 accessToken: "",
 refreshToken: "",
 expiresAt:0,
 domain: "www.codebuddy.cn",
 uid: "",
 nickname: "",
 uin: "",
 }
 }
}
