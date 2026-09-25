import "server-only"

import { createHash } from "node:crypto"
import type { WorkbuddyAccount } from "./account"
import { appendTaskDebug } from "./task-debug"

/**
 * WorkBuddy上游请求公共层。
 *
 *上游对不同客户端（桌面端 / Web / CLI /小程序）认不同的头族与事件指纹，
 *这里按 `workbuddy2api-panel`（GitHub开源项目）的实测口径统一出站头：
 * - `billing`：CLI域账单/任务/上报（www.codebuddy.cn），UA为 CLI形状
 * - `desktop`：桌面端 copilot.tencent.com行为上报，UA为三段式桌面 UA
 * - `web`：官网 www.workbuddy.cn页面行为/领奖，带 x-client-platform: web
 * - `mp`：小程序埋点上报，带小程序专属平台头
 */

export const WORKBUDDY_CLIENT_VERSION = "5.5.6"
export const WORKBUDDY_CLI_VERSION = "2.137.1"
export const DESKTOP_UA = `WorkBuddy/${WORKBUDDY_CLIENT_VERSION} WorkBuddy/${WORKBUDDY_CLIENT_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`
export const BILLING_UA = `WorkBuddy/${WORKBUDDY_CLIENT_VERSION}`
export const WEB_UA =
 "Mozilla/5.0 (Windows NT10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"

/**小程序埋点上报的客户端标识（桌面端 bundle /小程序 appservice实测口径）。 */
export const MP_CLIENT_PRODUCT = "workbuddy-mp"
export const MP_CLIENT_VERSION = "2.4.0"

export interface RealmBase {
 /** copilot.tencent.com（CN）/ www.workbuddy.ai（国际）：chat、growth、桌面上报。 */
 chat: string
 /** www.codebuddy.cn（CN）：余额、签到、活跃上报。 */
 billing: string
 /** www.workbuddy.cn（CN）：官网成长中心领奖与页面行为上报。 */
 web: string
}

const CN_BASE: RealmBase = {
 chat: "https://copilot.tencent.com",
 billing: "https://www.codebuddy.cn",
 web: "https://www.workbuddy.cn",
}

const GLOBAL_BASE: RealmBase = {
 chat: "https://www.workbuddy.ai",
 billing: "https://www.workbuddy.ai",
 web: "https://www.workbuddy.ai",
}

export function realmBase(account: WorkbuddyAccount): RealmBase {
 return account.domain.includes("workbuddy.ai") ? GLOBAL_BASE : CN_BASE
}

export type UpstreamFingerprint = "billing" | "desktop" | "web" | "mp"

export class WorkbuddyTaskApiError extends Error {
 constructor(
 message: string,
 readonly payload: unknown,
 readonly status?: number,
 ) {
 super(message)
 this.name = "WorkbuddyTaskApiError"
 }

 /**业务/HTTP400：调用方按需降级或跳过（如 mp领奖回落 Web域）。 */
 get isBadRequest() {
 return this.status ===400
 }
}

export interface TaskFetchInit {
 method: "GET" | "POST"
 body?: unknown
 /**客户端指纹，默认 billing（CLI形状）。 */
 fingerprint?: UpstreamFingerprint
 /** growth任务的 mp口径：额外带 X-Client-Platform: miniprogram。 */
 platform?: "web" | "miniprogram"
 /** web指纹的 Referer页面地址。 */
 pageUrl?: string
 /**成功时是否跳过 {code,msg,data}信封校验（默认校验）。 */
 skipEnvelope?: boolean
 debug?: boolean
 timeoutMs?: number
}

/**由 uid稳定派生36位标识（machineId/sessionId/qimei复用，模拟固定设备）。 */
export function stableId(uid: string, salt: string) {
 return createHash("sha256").update(`${salt}:${uid}`).digest("hex").slice(0,36)
}

export function buildHeaders(
 account: WorkbuddyAccount,
 init: TaskFetchInit,
): Record<string, string> {
 const fingerprint = init.fingerprint ?? "billing"
 const base = realmBase(account)
 const headers: Record<string, string> = {
 authorization: `Bearer ${account.accessToken}`,
 accept: "application/json",
 "content-type": "application/json",
 "x-codebuddy-request": "1",
 }

 if (fingerprint === "billing") {
 headers["accept-language"] = "zh-CN"
 headers["user-agent"] = BILLING_UA
 } else if (fingerprint === "desktop") {
 headers.accept = "application/json, text/plain, */*"
 headers["content-type"] = "application/json;charset=UTF-8"
 headers["user-agent"] = DESKTOP_UA
 headers["x-product"] = "SaaS"
 headers["x-request-id"] = `${stableId(account.uid, "req")}${Date.now() %1_000_000}`
 headers["x-domain"] = base.chat
 } else if (fingerprint === "web") {
 headers["user-agent"] = WEB_UA
 headers["x-client-platform"] = "web"
 headers.origin = base.web
 headers.referer = init.pageUrl ?? `${base.web}/profile/growth-center`
 } else {
 headers["user-agent"] = WEB_UA
 headers["x-client-product"] = MP_CLIENT_PRODUCT
 headers["x-client-version"] = MP_CLIENT_VERSION
 headers["x-client-platform"] = "mp-weixin"
 headers["x-platform"] = "wechatmp"
 }

 if (account.uid && !headers["x-user-id"]) {
 headers["x-user-id"] = account.uid
 }
 if (fingerprint !== "desktop" && account.domain) {
 headers["x-domain"] = account.domain
 }
 if (init.platform) {
 headers["x-client-platform"] = init.platform
 }
 return headers
}

export function assertOk(payload: unknown, context: string): Record<string, unknown> {
 if (!payload || typeof payload !== "object") {
 throw new WorkbuddyTaskApiError(`${context}：响应不是 JSON对象`, payload)
 }

 const record = payload as Record<string, unknown>
 if (record.code !==0 && record.code !== undefined) {
 const message =
 typeof record.msg === "string" ? record.msg : JSON.stringify(record).slice(0,200)
 throw new WorkbuddyTaskApiError(`${context}失败：code=${record.code} ${message}`, payload)
 }

 return record
}

export async function taskFetch(
 account: WorkbuddyAccount,
 url: string,
 init: TaskFetchInit,
 context: string,
): Promise<Record<string, unknown>> {
 const fingerprint = init.fingerprint ?? "billing"
 const startedAt = Date.now()
 let response: Response | undefined
 const headers = buildHeaders(account, init)

 const controller = new AbortController()
 const timeout = setTimeout(() => controller.abort(), init.timeoutMs ??20_000)

 try {
 response = await fetch(url, {
 method: init.method,
 headers,
 body: init.body === undefined ? undefined : JSON.stringify(init.body),
 signal: controller.signal,
 cache: "no-store",
 })
 const text = await response.text()

 if (!response.ok) {
 throw new WorkbuddyTaskApiError(
 `${context}：HTTP ${response.status} ${text.trim().slice(0,200)}`,
 text.trim().slice(0,1000),
 response.status,
 )
 }

 let payload: unknown
 try {
 payload = JSON.parse(text)
 } catch {
 throw new WorkbuddyTaskApiError(
 `${context}：响应不是 JSON：${text.trim().slice(0,180)}`,
 text.trim().slice(0,1000),
 )
 }

 if (init.skipEnvelope) {
 return (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>
 }
 return assertOk(payload, context)
 } catch (error) {
 if (error instanceof WorkbuddyTaskApiError) throw error
 if (error instanceof Error && error.name === "AbortError") {
 throw new WorkbuddyTaskApiError(`${context}：请求超时`, undefined)
 }
 throw new WorkbuddyTaskApiError(
 `${context}：${error instanceof Error ? error.message : String(error)}`,
 undefined,
 )
 } finally {
 clearTimeout(timeout)
 if (init.debug) {
 await appendTaskDebug(
 `[workbuddy-task] ${new Date().toISOString()} ${context} ${init.method} ${url} fingerprint=${fingerprint} status=${response?.status} durationMs=${Date.now() - startedAt}`,
 )
 }
 }
}

/**宽松读数字：接受 number与数字字符串，非法返回 undefined。 */
export function asNumber(value: unknown): number | undefined {
 if (typeof value === "number" && Number.isFinite(value)) return value
 if (typeof value === "string" && value.trim()) {
 const parsed = Number(value)
 if (Number.isFinite(parsed)) return parsed
 }
 return undefined
}

/**截断错误文本，避免把上游长响应原样透给前端。 */
export function truncateStr(text: string, limit: number) {
 return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**生成带前缀的唯一 id（上游不校验一致性，但要求形态可用）。 */
export function uniqueId(prefix: string) {
 return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2,10)}`
}
