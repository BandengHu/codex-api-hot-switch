import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
 realmBase,
 stableId,
 taskFetch,
 WEB_UA,
} from "./api-client"

/**
 * WorkBuddy行为上报（`/v2/report`）通道。
 *
 *同一条路径上有**四套客户端指纹**，任务计分认哪套由任务决定（照搬
 * `workbuddy2api-panel`的实测结论）：
 * - `chat`：CLI域 `{billing}/v2/report`，`chat_request_send`事件（chat_5 /连登 /
 * first_buddy前置）；
 * - `desktop`：`{chat}/v2/report`，桌面端事件链（RichMeow_Chat / Buddy_App /
 * automation_1 / template_5 / expert_5等）；
 * - `web`：`{web}/v2/report`，浏览器形状事件（Library_read）；
 * - `mp`：`{billing}/v2/report` +小程序平台头（school_season / Sequential_Tasks_*）。
 *
 *所有事件的公共指纹字段由 `withXxxFingerprint`注入，业务字段优先（可覆盖）。
 */

export type UpstreamEvent = Record<string, unknown>

/**桌面端公共指纹（注入每个桌面事件）。 */
export function desktopFingerprint(account: WorkbuddyAccount): UpstreamEvent {
 const now = Date.now()
 return {
 timezone: "Asia/Shanghai",
 reportDelay:2000,
 userId: account.uid,
 username: account.nickname,
 userNickname: account.nickname,
 product: "SaaS",
 releaseDate:1789036585355,
 commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
 ideName: "WorkBuddy",
 ideType: "WorkBuddy",
 ideVersion: "5.5.6",
 machineId: stableId(account.uid, "machine"),
 sessionId: stableId(account.uid, "session"),
 extName: "workbuddy-desktop",
 extVersion: "5.5.6",
 os: "win32",
 arch: "x64",
 osVersion: "10.0.26220",
 cpuCores:20,
 memorySize:24,
 timestamp: now,
 presentAt: now,
 }
}

/**小程序埋点公共指纹（appservice `wQ()` + `Ao()`对齐）。 */
export function mpFingerprint(account: WorkbuddyAccount): UpstreamEvent {
 return {
 timestamp: Date.now(),
 ideType: "WorkBuddy_MP",
 ideVersion: "2.4.0",
 extName: "workbuddy-mp",
 extVersion: "2.4.0",
 product: "SaaS",
 ideName: "wx_app_cloud",
 platform: "mini_program",
 os: "windows",
 osVersion: "11",
 arch: "x64",
 machineId: "0655736a-607f-4d9d-b430-58176ee9a090",
 timezone: "Asia/Shanghai",
 userId: account.uid,
 userNickname: account.nickname,
 }
}

function mergeEvents(base: UpstreamEvent, events: UpstreamEvent[]): UpstreamEvent[] {
 return events.map((event) => ({ ...base, ...event }))
}

/**桌面指纹批量上报到 `{chat}/v2/report`。 */
export async function reportDesktopEvents(
 account: WorkbuddyAccount,
 events: UpstreamEvent[],
): Promise<void> {
 if (!events.length) throw new Error("desktop report：没有事件")
 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.chat}/v2/report`,
 { method: "POST", fingerprint: "desktop", body: mergeEvents(desktopFingerprint(account), events) },
 "上报桌面端事件",
 )
}

/**小程序指纹批量上报到 `{billing}/v2/report`。 */
export async function reportMpEvents(
 account: WorkbuddyAccount,
 events: UpstreamEvent[],
): Promise<void> {
 if (!events.length) throw new Error("mp report：没有事件")
 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.billing}/v2/report`,
 { method: "POST", fingerprint: "mp", body: mergeEvents(mpFingerprint(account), events) },
 "上报小程序事件",
 )
}

/**
 * Web指纹单事件上报到 `{web}/v2/report`。
 *
 *与桌面指纹不同：web域事件是浏览器形状（os/machineId/userAgent），
 *用于 Library_read等页面行为类任务（实测 `library_doc_intro_click`4秒点亮）。
 */
export async function reportWebEvent(
 account: WorkbuddyAccount,
 eventCode: string,
 pageUrl: string,
 elementId: string,
 elementName: string,
): Promise<void> {
 const base = realmBase(account)
 const event: UpstreamEvent = {
 eventCode,
 timestamp: Date.now(),
 reportDelay:0,
 pageURL: pageUrl,
 elementId,
 elementName,
 os: "Win32",
 arch: "",
 osVersion: "10.0",
 userAgent: WEB_UA,
 machineId: stableId(account.uid, "webmachine"),
 userId: account.uid,
 userNickname: account.nickname,
 }
 await taskFetch(
 account,
 `${base.web}/v2/report`,
 { method: "POST", fingerprint: "web", pageUrl, body: [event] },
 "上报页面行为事件",
 )
}

/**
 * CLI域活跃上报（`chat_request_send`）。
 *
 *事件必须带 `userId`（=账号 uid），缺失则服务端200但静默丢弃。一条上报同时点亮
 * growth连登 +解锁 `first_buddy`任务（领养前置）。
 */
export async function reportChatActivity(
 account: WorkbuddyAccount,
 conversationId: string,
 requestId: string,
 modelId = "deepseek-v4-flash",
 modelName = "DeepSeek V4 Flash",
): Promise<void> {
 const base = realmBase(account)
 const now = Date.now()
 await taskFetch(
 account,
 `${base.billing}/v2/report`,
 {
 method: "POST",
 fingerprint: "desktop",
 debug: process.env.WORKBUDDY_TASK_DEBUG === "1",
 body: [
 createChatRequestEvent(account, conversationId, requestId || conversationId, now, modelId, modelName),
 ],
 },
 "上报对话活跃",
 )
}

/**客户端 `chat_request_send`事件完整形状（字段名与上游 JSON对齐）。 */
export function createChatRequestEvent(
 account: WorkbuddyAccount,
 conversationId: string,
 requestId: string,
 now: number,
 modelId: string,
 modelName: string,
): UpstreamEvent {
 return {
 eventCode: "chat_request_send",
 timestamp: now,
 reportDelay:0,
 mode: "craft",
 conversationId,
 requestId,
 inputLength:12,
 requestModelId: modelId,
 requestModelName: modelName,
 isPlan: false,
 isAutoExecuteTerminal: false,
 isAutoModify: false,
 codebaseEnable: false,
 maxToken:0,
 maxSteps:0,
 temperature:0,
 maxRetries:0,
 mentionContexts: [],
 knowledgeId: [],
 knowledgeName: [],
 codebaseId: "",
 mentionContextCount:0,
 command: "",
 expertId: "",
 recommendId: "",
 skillId: "",
 skillCount:0,
 totalCount:0,
 fileUri: "",
 presentAt: now,
 traceId: "",
 rootRequestId: requestId,
 parentConversationId: conversationId,
 agentName: "default",
 agentType: "conversation",
 userId: account.uid,
 }
}

