import "server-only"

import {
  buildGlobalCredentialFile,
  fetchGlobalOauthAccount,
  GLOBAL_OAUTH_SESSION_TTL_MS,
  isSafeGlobalUid,
  pollGlobalOauthTokens,
  startGlobalOauth,
} from "./global-oauth"
import { importGlobalAccount } from "./global-pool-store"
import { fetchBalance } from "./task-api"

/**
 * 国际版号池「浏览器授权登录」会话管理（进程内）。
 *
 * 流程：取授权 URL → 用户在浏览器完成登录 → 本地轮询 token → 凭据落盘进国际版号池
 * → 顺带拉一次余额。
 *
 * 与国内站登录会话的差别：国际站登录**不需要**先有本机登录态来判定域，整条链路
 * 固定打 `www.workbuddy.ai`，所以这里没有任何「本机账号」依赖。
 */

interface GlobalLoginSession {
  createdAt: number
  authUrl: string
}

const sessions = new Map<string, GlobalLoginSession>()

function pruneSessions() {
  const now = Date.now()
  for (const [state, session] of sessions) {
    if (now - session.createdAt > GLOBAL_OAUTH_SESSION_TTL_MS) sessions.delete(state)
  }
}

export interface GlobalLoginStartPayload {
  state: string
  url: string
  expiresInMs: number
}

export async function beginGlobalPoolLogin(): Promise<GlobalLoginStartPayload> {
  pruneSessions()
  const { state, authUrl } = await startGlobalOauth()
  sessions.set(state, { createdAt: Date.now(), authUrl })
  return { state, url: authUrl, expiresInMs: GLOBAL_OAUTH_SESSION_TTL_MS }
}

export interface GlobalLoginPollDone {
  done: true
  uid: string
  nickname: string
  credits: number
  creditsTotal: number
}

export interface GlobalLoginPollPending {
  done: false
  message: string
}

export async function pollGlobalPoolLogin(
  state: string,
): Promise<GlobalLoginPollDone | GlobalLoginPollPending> {
  pruneSessions()
  if (!sessions.has(state)) {
    throw new Error("国际版授权会话不存在或已过期，请重新发起登录")
  }

  const tokens = await pollGlobalOauthTokens(state)
  if (!tokens) return { done: false, message: "等待浏览器完成登录" }

  const info = await fetchGlobalOauthAccount(tokens.accessToken)
  if (!info.uid) throw new Error("已登录但拿不到 uid，请重试")
  if (!isSafeGlobalUid(info.uid)) {
    throw new Error("上游返回的 uid 含非法字符，拒绝落盘（防路径穿越）")
  }

  const raw = buildGlobalCredentialFile(tokens, info)
  const entry = await importGlobalAccount(raw)
  sessions.delete(state)

  let credits = -1
  let creditsTotal = 0
  try {
    const balance = await fetchBalance({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + Math.max(0, tokens.expiresIn) * 1000,
      domain: tokens.domain || "www.workbuddy.ai",
      uid: info.uid,
      nickname: info.nickname,
      uin: "",
    })
    credits = balance.remain
    creditsTotal = balance.size
  } catch {
    // 余额拉不到不影响登录结果（凭据已落盘）。
  }

  return {
    done: true,
    uid: entry.uid,
    nickname: info.nickname,
    credits,
    creditsTotal,
  }
}
