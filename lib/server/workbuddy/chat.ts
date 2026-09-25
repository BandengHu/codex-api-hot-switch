import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
 DESKTOP_UA,
 realmBase,
 truncateStr,
 WorkbuddyTaskApiError,
} from "./api-client"

/**
 *真实对话（CLI /桌面指纹）。
 *
 *部分任务（Model_chat_GLM5.2 / black_cat「夜猫子」）的判据里带「真实对话」语义：
 *行为事件之外还要有一次真实的 chat请求。这里按 `workbuddy2api-panel`
 *（GitHub开源项目）口径发一次极短对话（`1+1等于几？`），读干流避免残留连接。
 *
 *注意：上游只接受 `stream: true`。
 */

export interface ChatOptions {
 model?: string
 /**带 `X-Expert-Id`（专家类任务用桌面指纹对话）。 */
 expertId?: string
 /**桌面指纹头族（默认 CLI）。 */
 desktop?: boolean
 conversationId?: string
}

export async function runWorkbuddyChat(
 account: WorkbuddyAccount,
 options: ChatOptions = {},
): Promise<void> {
 const base = realmBase(account)
 const model = options.model ?? "deepseek-v4-flash"
 const conversationId = options.conversationId ?? `wb-chat-${Date.now()}`
 const headers: Record<string, string> = {
 authorization: `Bearer ${account.accessToken}`,
 "content-type": "application/json",
 accept: "text/event-stream",
 "x-codebuddy-request": "1",
 "x-agent-intent": "craft",
 "x-agent-type": "main",
 }
 if (options.desktop) {
 Object.assign(headers, {
 "user-agent": DESKTOP_UA,
 "x-domain": base.chat,
 "x-product": "SaaS",
 "x-conversation-id": conversationId,
 "x-request-id": `${Date.now()}`,
 "x-ide-name": "WorkBuddy",
 "x-ide-type": "WorkBuddy",
 "x-ide-version": "5.5.6",
 })
 } else {
 Object.assign(headers, {
 "user-agent": `CLI/2.137.1 CodeBuddy/2.137.1`,
 "x-domain": base.chat,
 "x-product": "SaaS",
 "x-ide-name": "CLI",
 "x-ide-type": "CLI",
 "x-ide-version": "2.137.1",
 })
 }
 if (account.uid) headers["x-user-id"] = account.uid
 if (options.expertId) headers["x-expert-id"] = options.expertId

 const controller = new AbortController()
 const timeout = setTimeout(() => controller.abort(),120_000)
 try {
 const response = await fetch(`${base.chat}/v2/chat/completions`, {
 method: "POST",
 headers,
 cache: "no-store",
 signal: controller.signal,
 body: JSON.stringify({
 model,
 messages: [
 {
 role: "system",
 content: "You are a helpful assistant.当前处于中文环境，使用简体中文回答。",
 },
 { role: "user", content: "1+1等于几？直接回答。" },
 ],
 agent: "cli",
 temperature:1,
 stream: true,
 }),
 })
 if (!response.ok) {
 const text = await response.text()
 throw new WorkbuddyTaskApiError(
 `对话失败：HTTP ${response.status} ${truncateStr(text.trim(),180)}`,
 text.trim().slice(0,1000),
 response.status,
 )
 }
 //读干流：上游是 SSE且只接受 stream，提前断开会在网关侧留残留连接。
 const reader = response.body?.getReader()
 if (!reader) return
 try {
 let total =0
 while (total <1_048_576) {
 const { done, value } = await reader.read()
 if (done) break
 total += value?.length ??0
 }
 } finally {
 await reader.cancel().catch(() => undefined)
 }
 } catch (error) {
 if (error instanceof WorkbuddyTaskApiError) throw error
 if (error instanceof Error && error.name === "AbortError") {
 throw new WorkbuddyTaskApiError("对话超时", undefined)
 }
 throw new WorkbuddyTaskApiError(
 `对话失败：${error instanceof Error ? error.message : String(error)}`,
 undefined,
 )
 } finally {
 clearTimeout(timeout)
 }
}

/** `black_cat`「夜猫子」计数窗口：本地时区23:00–08:00。 */
export function inNightWindow(now = new Date()) {
 const hour = now.getHours()
 return hour >=23 || hour <8
}

/**夜猫子补足：发 need次 glm-5.2真实对话 +事件链上报，返回成功次数。 */
export async function runNightChats(
 account: WorkbuddyAccount,
 need: number,
 reportModelChat: (conversationId: string) => Promise<void>,
): Promise<number> {
 let ok =0
 for (let index =0; index < need; index++) {
 const conversationId = `wb-night-${Date.now()}-${index}`
 try {
 await runWorkbuddyChat(account, { model: "glm-5.2", conversationId })
 await reportModelChat(conversationId)
 ok++
 } catch {
 return ok
 }
 await new Promise((resolve) => setTimeout(resolve,4_000))
 }
 return ok
}

