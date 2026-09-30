import "server-only"

import { fetchProvider } from "@/lib/server/proxy/provider-fetch"
import { appendTaskDebug } from "./task-debug"

/**
 * WorkBuddy **国际版**（www.workbuddy.ai）设备授权登录。
 *
 * 国际站与国内站共用一套 `/v2/plugin/auth/*` 路径，但三处口径不同（对照 GitHub
 * 开源项目 `ErfanBagheri404/WorkBuddy2API` 实测）：
 *
 * 1. 设备流平台标识是 `workbuddy-ai`，国内站是 `CLI`；
 * 2. 取账号信息走 `GET /v2/plugin/accounts`（Bearer），返回 `data.accounts[0]`，
 *    国内站是 `GET /v2/plugin/login/account?state=`；
 * 3. 未完成登录时上游回**业务码 11217**（"login ing"），国内站表现为 HTTP 4xx。
 *
 * 登录态文件沿用桌面端 `workbuddy-desktop.info` 的 `{account, auth}` 形状，
 * 所以可以直接被现有解析器读回，也能直接吃 WorkBuddy2API 写出的
 * `~/.workbuddy2api-auth.json`。
 */

export const GLOBAL_WORKBUDDY_ORIGIN = "https://www.workbuddy.ai"
/** 国际站设备流的平台标识，与国内站的 `CLI` 不同。 */
export const GLOBAL_WORKBUDDY_PLATFORM = "workbuddy-ai"
/** 上游"登录进行中"的业务码，轮询期间按未完成处理。 */
export const GLOBAL_OAUTH_PENDING_CODE = 11217

export class WorkbuddyGlobalOauthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkbuddyGlobalOauthError"
  }
}

export interface GlobalOauthStartResult {
  state: string
  authUrl: string
}

export interface GlobalOauthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  domain: string
}

export interface GlobalOauthAccountInfo {
  uid: string
  nickname: string
}

export interface GlobalCredentialFile {
  account: {
    uid: string
    nickname: string
  }
  auth: {
    accessToken: string
    refreshToken: string
    domain: string
    expiresAt: number
    lastRefreshTime: number
  }
}

/** 授权会话有效期：超时的 state 直接回收。 */
export const GLOBAL_OAUTH_SESSION_TTL_MS = 15 * 60 * 1000

/**
 * 登录/刷新用的固定头。`X-No-*` 系列告诉上游"这是匿名登录请求，别去解析
 * 用户态"，国际站缺了会被拒。
 */
function globalLoginHeaders(extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "x-product": "SaaS",
    "x-no-authorization": "true",
    "x-no-user-id": "true",
    "x-no-enterprise-id": "true",
    "x-no-department-info": "true",
    "x-request-id": `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    origin: GLOBAL_WORKBUDDY_ORIGIN,
    referer: `${GLOBAL_WORKBUDDY_ORIGIN}/`,
    ...extra,
  }
}

async function globalJson(
  url: string,
  init: { method: "GET" | "POST"; body?: unknown; bearer?: string; refreshToken?: string },
  context: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  let status = 0
  try {
    const headers = globalLoginHeaders({
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      ...(init.refreshToken ? { "x-refresh-token": init.refreshToken } : {}),
    })
    const response = await fetchProvider(url, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store",
    })
    status = response.status
    const text = await response.text()
    if (!response.ok) {
      throw new WorkbuddyGlobalOauthError(
        `${context}：HTTP ${response.status} ${text.trim().slice(0, 200)}`,
      )
    }
    try {
      return asRecord(JSON.parse(text))
    } catch {
      throw new WorkbuddyGlobalOauthError(
        `${context}：响应不是 JSON：${text.trim().slice(0, 180)}`,
      )
    }
  } catch (error) {
    if (error instanceof WorkbuddyGlobalOauthError) throw error
    if (error instanceof Error && error.name === "AbortError") {
      throw new WorkbuddyGlobalOauthError(`${context}：请求超时`)
    }
    throw new WorkbuddyGlobalOauthError(
      `${context}：${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timeout)
    if (process.env.WORKBUDDY_TASK_DEBUG === "1") {
      await appendTaskDebug(
        `[workbuddy-global-oauth] ${new Date().toISOString()} ${context} ${init.method} ${url} status=${status}`,
      )
    }
  }
}

/** 第一步：取授权 URL（国际站平台标识 `workbuddy-ai`）。 */
export async function startGlobalOauth(): Promise<GlobalOauthStartResult> {
  const payload = await globalJson(
    `${GLOBAL_WORKBUDDY_ORIGIN}/v2/plugin/auth/state?platform=${GLOBAL_WORKBUDDY_PLATFORM}`,
    { method: "POST", body: {} },
    "获取国际版授权链接",
  )
  const data = asRecord(payload.data)
  const state = asString(data.state)
  const authUrl = asString(data.authUrl)
  if (!state || !authUrl) {
    throw new WorkbuddyGlobalOauthError(
      `获取国际版授权链接失败：缺少 state 或 authUrl（${JSON.stringify(payload).slice(0, 180)}）`,
    )
  }
  return { state, authUrl }
}

/**
 * 第三步：取 token（一次）。
 *
 * 未完成登录时上游回业务码 11217，这里返回 `undefined` 让调用方继续轮询；
 * 其余 HTTP/传输层错误才抛。
 */
export async function pollGlobalOauthTokens(
  state: string,
): Promise<GlobalOauthTokens | undefined> {
  let payload: Record<string, unknown>
  try {
    payload = await globalJson(
      `${GLOBAL_WORKBUDDY_ORIGIN}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
      { method: "GET" },
      "获取国际版登录 token",
    )
  } catch (error) {
    // 上游 pending 也可能表现为 HTTP 4xx，按未完成处理。
    if (error instanceof WorkbuddyGlobalOauthError && /HTTP 4\d\d/.test(error.message)) {
      return undefined
    }
    throw error
  }

  const code = payload.code
  if (code !== 0 && code !== undefined) {
    // 11217 = login ing，继续等；其余业务码视为未完成，由轮询超时兜底。
    return undefined
  }
  const data = asRecord(payload.data)
  const accessToken = asString(data.accessToken)
  if (!accessToken) return undefined
  return {
    accessToken,
    refreshToken: asString(data.refreshToken),
    expiresIn: asNumber(data.expiresIn),
    domain: asString(data.domain),
  }
}

/** 第四步：取账号信息。国际站走 `/v2/plugin/accounts`，取第一个账号。 */
export async function fetchGlobalOauthAccount(
  accessToken: string,
): Promise<GlobalOauthAccountInfo> {
  const payload = await globalJson(
    `${GLOBAL_WORKBUDDY_ORIGIN}/v2/plugin/accounts`,
    { method: "GET", bearer: accessToken },
    "获取国际版账号信息",
  )
  const accounts = asRecord(payload.data).accounts
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new WorkbuddyGlobalOauthError("国际版账号信息为空：上游没有返回任何账号")
  }
  const first = asRecord(accounts[0])
  return {
    uid: asString(first.uid),
    nickname: asString(first.nickname),
  }
}

/**
 * 用 refreshToken 换新 token。国际站刷新走 `/v2/plugin/auth/token/refresh`，
 * 凭据放在 `X-Refresh-Token` 头里，而不是 body。
 */
export async function refreshGlobalTokens(
  refreshToken: string,
): Promise<GlobalOauthTokens> {
  const payload = await globalJson(
    `${GLOBAL_WORKBUDDY_ORIGIN}/v2/plugin/auth/token/refresh`,
    { method: "POST", body: {}, refreshToken },
    "刷新国际版登录态",
  )
  const code = payload.code
  if (code !== 0 && code !== undefined) {
    throw new WorkbuddyGlobalOauthError(
      `刷新国际版登录态失败：${asString(payload.msg) || `code=${String(code)}`}`,
    )
  }
  const data = asRecord(payload.data)
  const accessToken = asString(data.accessToken)
  if (!accessToken) {
    throw new WorkbuddyGlobalOauthError("刷新国际版登录态失败：响应缺少 accessToken")
  }
  return {
    accessToken,
    refreshToken: asString(data.refreshToken) || refreshToken,
    expiresIn: asNumber(data.expiresIn),
    domain: asString(data.domain),
  }
}

/** 组装号池凭据文件（与 `workbuddy-desktop.info` 同格式）。 */
export function buildGlobalCredentialFile(
  tokens: GlobalOauthTokens,
  info: GlobalOauthAccountInfo,
): string {
  const now = Date.now()
  const doc: GlobalCredentialFile = {
    account: {
      uid: info.uid,
      nickname: info.nickname,
    },
    auth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      domain: tokens.domain || "www.workbuddy.ai",
      // 上游没给有效期时给一年，避免本地立刻判过期。
      expiresAt: now + Math.max(0, tokens.expiresIn || 365 * 24 * 3600) * 1000,
      lastRefreshTime: now,
    },
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

/** uid 安全校验：只放行 `[A-Za-z0-9_-]`，防止拼文件名时路径穿越。 */
export function isSafeGlobalUid(uid: string) {
  return uid.length > 0 && uid.length <= 64 && /^[A-Za-z0-9_-]+$/.test(uid)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}
