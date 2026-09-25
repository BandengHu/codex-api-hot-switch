import "server-only"

import type { WorkbuddyAccount } from "./account"
import { BILLING_UA, realmBase } from "./api-client"
import { appendTaskDebug } from "./task-debug"

/**
 * WorkBuddy OAuth设备授权登录。
 *
 *照搬 `workbuddy2api-panel`（GitHub开源项目）实测流程——**不是扫码**，上游也没有
 *自渲染二维码的公开端点；官方桌面端同样是弹浏览器授权：
 *
 *1. `POST {chat}/v2/plugin/auth/state?platform=CLI`（无 PKCE，state由服务端签发）
 * → `data:{state, authUrl}`
 *2.用户在浏览器打开 `authUrl`完成登录
 *3.轮询 `GET {chat}/v2/plugin/auth/token?state=<state>`：pending时业务 code非0，
 *完成时 code=0 + token bundle（accessToken/refreshToken/expiresIn/domain）
 *4. `GET {chat}/v2/plugin/login/account?state=<state>`（带 Bearer）拿 uid/昵称
 *
 *请求头与 `cmd/login`/面板内嵌流程一致（Origin/Referer按域名切换，UA为 CLI形状）。
 * cookie不做保持：每请求携带 state，无会话态。
 */

export class WorkbuddyOauthError extends Error {
 constructor(message: string) {
 super(message)
 this.name = "WorkbuddyOauthError"
 }
}

export interface OauthStartResult {
 state: string
 authUrl: string
}

export interface OauthTokens {
 accessToken: string
 refreshToken: string
 expiresIn: number
 domain: string
}

export interface OauthAccountInfo {
 uid: string
 enterpriseId: string
 nickname: string
}

/**授权会话有效期：超时的 state直接回收（防「开弹窗走开」的滞留）。 */
export const OAUTH_SESSION_TTL_MS =15 *60 *1000

function oauthHeaders(account?: WorkbuddyAccount) {
 const base = account ? realmBase(account) : undefined
 const origin = base?.web ?? "https://www.codebuddy.cn"
 return {
 "content-type": "application/json",
 accept: "application/json, text/plain, */*",
 "x-requested-with": "XMLHttpRequest",
 origin,
 referer: `${origin}/`,
 "user-agent": BILLING_UA,
 }
}

async function oauthJson(
 url: string,
 init: { method: "GET" | "POST"; bearer?: string; body?: unknown },
 context: string,
): Promise<unknown> {
 const controller = new AbortController()
 const timeout = setTimeout(() => controller.abort(),30_000)
 let status =0
 try {
 const response = await fetch(url, {
 method: init.method,
 headers: {
 ...oauthHeaders(),
 ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
 },
 body: init.body === undefined ? undefined : JSON.stringify(init.body),
 signal: controller.signal,
 cache: "no-store",
 })
 status = response.status
 const text = await response.text()
 if (!response.ok) {
 throw new WorkbuddyOauthError(`${context}：HTTP ${response.status} ${text.trim().slice(0,200)}`)
 }
 let payload: unknown
 try {
 payload = JSON.parse(text)
 } catch {
 throw new WorkbuddyOauthError(`${context}：响应不是 JSON：${text.trim().slice(0,180)}`)
 }
 return payload
 } catch (error) {
 if (error instanceof WorkbuddyOauthError) throw error
 if (error instanceof Error && error.name === "AbortError") {
 throw new WorkbuddyOauthError(`${context}：请求超时`)
 }
 throw new WorkbuddyOauthError(
 `${context}：${error instanceof Error ? error.message : String(error)}`,
 )
 } finally {
 clearTimeout(timeout)
 if (process.env.WORKBUDDY_TASK_DEBUG === "1") {
 await appendTaskDebug(
 `[workbuddy-oauth] ${new Date().toISOString()} ${context} ${init.method} ${url} status=${status}`,
 )
 }
 }
}

function asRecord(value: unknown): Record<string, unknown> {
 return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/**第一步：取授权 URL（不发账号请求，纯 CLI口径）。 */
export async function startOauth(account: WorkbuddyAccount): Promise<OauthStartResult> {
 const base = realmBase(account)
 const payload = asRecord(
 await oauthJson(
 `${base.chat}/v2/plugin/auth/state?platform=CLI`,
 { method: "POST", body: {} },
 "获取授权链接",
 ),
 )
 const data = asRecord(payload.data)
 const state = typeof data.state === "string" ? data.state : ""
 const authUrl = typeof data.authUrl === "string" ? data.authUrl : ""
 if (!state || !authUrl) {
 throw new WorkbuddyOauthError(`获取授权链接失败：缺少 state或 authUrl（${JSON.stringify(payload).slice(0,180)}）`)
 }
 return { state, authUrl }
}

/**
 *第三步：取 token（一次）。
 *
 * pending（未完成登录）时上游返回业务 code非0，这里返回 undefined让调用方继续轮询；
 * HTTP/传输层错误才抛。
 */
export async function pollOauthTokens(
 account: WorkbuddyAccount,
 state: string,
): Promise<OauthTokens | undefined> {
 const base = realmBase(account)
 let payload: Record<string, unknown>
 try {
 payload = asRecord(
 await oauthJson(
 `${base.chat}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
 { method: "GET" },
 "获取登录 token",
 ),
 )
 } catch (error) {
 //上游 pending表现为 HTTP4xx +业务提示（"login ing"），按未完成处理。
 if (error instanceof WorkbuddyOauthError && /HTTP4\d\d/.test(error.message)) return undefined
 throw error
 }
 const code = payload.code
 if (code !==0 && code !== undefined) return undefined

 const data = asRecord(payload.data)
 const accessToken = typeof data.accessToken === "string" ? data.accessToken : ""
 if (!accessToken) return undefined
 return {
 accessToken,
 refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : "",
 expiresIn: typeof data.expiresIn === "number" ? data.expiresIn :0,
 domain: typeof data.domain === "string" ? data.domain : "",
 }
}

/**第四步：取账号信息（uid/昵称；失败不阻塞——仅缺展示名）。 */
export async function fetchOauthAccount(
 account: WorkbuddyAccount,
 state: string,
 accessToken: string,
): Promise<OauthAccountInfo> {
 const base = realmBase(account)
 const payload = asRecord(
 await oauthJson(
 `${base.chat}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
 { method: "GET", bearer: accessToken },
 "获取账号信息",
 ),
 )
 const data = asRecord(payload.data)
 return {
 uid: typeof data.uid === "string" ? data.uid : "",
 enterpriseId: typeof data.enterpriseId === "string" ? data.enterpriseId : "",
 nickname: typeof data.nickname === "string" ? data.nickname : "",
 }
}

/**
 *组装号池凭据文件（与 `workbuddy-desktop.info`同格式，可直接被
 * `parseWorkbuddyAccount`解析）。
 */
export function buildCredentialFile(
 tokens: OauthTokens,
 info: OauthAccountInfo,
): string {
 const expiresAt = Date.now() + Math.max(0, tokens.expiresIn) *1000
 const doc = {
 account: {
 uid: info.uid,
 nickname: info.nickname,
 enterpriseId: info.enterpriseId,
 },
 auth: {
 accessToken: tokens.accessToken,
 refreshToken: tokens.refreshToken,
 expiresAt,
 expiresIn: tokens.expiresIn,
 domain: tokens.domain,
 },
 }
 return `${JSON.stringify(doc, null,1)}\n`
}

/**
 * uid安全校验：只放行 `[A-Za-z0-9_-]`。
 *
 * uid来自上游响应，未校验就拼文件名会被路径穿越利用
 * （`workbuddy-../../evil.json`）。腾讯侧 uid实测为 UUID形态。
 */
export function isValidUid(uid: string) {
 return uid.length >0 && uid.length <=64 && /^[A-Za-z0-9_-]+$/.test(uid)
}

