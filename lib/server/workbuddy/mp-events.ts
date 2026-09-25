import "server-only"

import type { UpstreamEvent } from "./report"
import { uniqueId } from "./api-client"

/**
 *小程序（mini program）埋点事件构造。
 *
 *来源：`workbuddy2api-panel`（GitHub开源项目）小程序 MCP逆向 +多账号实测
 *（小程序的判据事件与桌面/web是**两套口径**，勿照抄）：
 * - `chat_request_send`：小程序首对话 /五次对话 /校园日；
 * - `expert_actual_use`：小程序选专家对话（不带 conversationId/activityId、
 * extVersion=2.2.8、type=send_message）；
 * - `playbook_cta_click` + `playbook_prompt_send`：小程序灵感功能。
 */

/**校园日 /开学季活动 id（事件 activityId字段值，school/growth两域共用）。 */
export const SCHOOL_OPEN_DAY_ACTIVITY_ID = "school_open_day_2026"

/**小程序对话事件（`chat_request_send`，school域 chat_3_times与 growth域共用形状）。 */
export function mpChatRequestEvent(conversationId: string): UpstreamEvent {
 const requestId = uniqueId("wb-mp")
 return {
 eventCode: "chat_request_send",
 inputLength:14,
 isPlan: false,
 isAutoExecuteTerminal: false,
 isAutoModify: false,
 codebaseEnable: false,
 maxToken:0,
 maxSteps:500,
 temperature:0,
 maxRetries:0,
 mentionContexts: [],
 knowledgeId: [],
 knowledgeName: [],
 codebaseId: "",
 mentionContextCount:0,
 command: "",
 recommendId: "",
 skillId: "",
 skillCount:0,
 totalCount:0,
 traceId: requestId,
 rootRequestId: requestId,
 parentConversationId: conversationId,
 conversationId,
 messageId: `msg-${requestId.slice(-8)}`,
 agentName: "mp",
 agentType: "main",
 "codebuddy.session_id": conversationId,
 "codebuddy.conversation_request_id": requestId,
 }
}

/**
 *校园日（`school_season`）判据事件：小程序对话 + `activityId`。
 *实测无 activityId的事件不点亮。
 */
export function schoolSeasonChatEvent(conversationId: string): UpstreamEvent {
 return { ...mpChatRequestEvent(conversationId), activityId: SCHOOL_OPEN_DAY_ACTIVITY_ID }
}

/**小程序对话 +模型字段（`Sequential_Tasks_5`「使用 GLM5.2」判据载体）。 */
export function mpChatModelEvent(
 conversationId: string,
 modelId: string,
 modelName: string,
): UpstreamEvent {
 return {
 ...mpChatRequestEvent(conversationId),
 requestModelId: modelId,
 requestModelName: modelName,
 }
}

/**
 *小程序「选中专家并完成有效对话」事件（`expert_actual_use`）。
 *
 *形状对齐小程序 app-service.js真实发射点：**不带** conversationId/activityId、
 * extVersion用小程序自身版本2.2.8、type固定 `send_message`。
 * expertId必须是专家市场真实 `ex_` id（空 id服务端不入账）。
 */
export function mpExpertUseEvent(
 expertId: string,
 expertName: string,
 expertType: string,
): UpstreamEvent {
 return {
 eventCode: "expert_actual_use",
 reportDelay:0,
 extVersion: "2.2.8",
 source: "mini_program",
 id: expertId,
 name: expertId,
 expertTitle: expertName || expertId,
 type: "send_message",
 characterCount:12,
 expertType: expertType || "agent",
 }
}

/**
 *小程序灵感事件组（`Sequential_Tasks_7`「体验灵感功能」判据载体）：
 * playbook_cta_click → playbook_prompt_send。
 */
export function mpPlaybookEvents(caseId: string, caseName: string): UpstreamEvent[] {
 const payload: UpstreamEvent = {
 id: caseId,
 name: caseName,
 type: "document",
 categoryId: "",
 categoryName: "",
 skills: "",
 skillNames: "",
 }
 return [
 { eventCode: "playbook_cta_click", source: "discover", position:1, extVersion: "2.2.8", ...payload },
 {
 eventCode: "playbook_prompt_send",
 source: "discover",
 promptLength:96,
 isOfficial:1,
 conversationId: uniqueId("wb-mp-pb"),
 extVersion: "2.2.8",
 ...payload,
 },
 ]
}

