import "server-only"

import type { WorkbuddyAccount } from "./account"
import { DESKTOP_UA, realmBase, taskFetch, uniqueId } from "./api-client"
import type { UpstreamEvent } from "./report"
import { reportDesktopEvents } from "./report"

/**
 *桌面客户端（WorkBuddy Desktop5.5.6）事件链构造 +专家/主题类接口。
 *
 *来源：`workbuddy2api-panel`（GitHub开源项目）2026-09-12抓包实测
 *（`data/desktop-task-protocol.md`）。桌面端点亮的任务不是靠独立端点，而是同一条
 * `POST {chat}/v2/report`通道上**桌面客户端指纹**的判据事件链。
 *
 *全部构造按实测样本1:1照搬，不改字段形状：服务端对事件链有真实性校验倾向
 *（如 RichMeow需要消息成功回执、expert类需要真实专家 id与服务端 requestId）。
 */

/**桌面端 UI字符串常量（判据载荷里的固定值）。 */
const FAST_MODEL = "fast-model"
/**企鹅教师助手（Buddy_App_QQ判据应用）。 */
const BUDDY_APP_ID = "cb_y5Dy46tPQGGWtueMxXbe"
const BUDDY_APP_NAME = "企鹅教师助手"
/**Hp_Appearance判据主题：和平精英激战金秋。 */
export const HP_APPEARANCE_THEME = "theme-tkmw7j"
/**Expert_lighthouse判据专家（腾讯轻量云）。 */
export const LIGHTHOUSE_EXPERT_ID = "ex_2cvvUZQhDyeJ"

export interface DesktopChatIds {
 conversationId: string
 requestId: string
 messageId: string
}

/**生成一轮桌面对话的 id组（上游不校验一致性，但要求形态可用）。 */
export function newDesktopChatIds(prefix = "wb"): DesktopChatIds {
 const seed = uniqueId(prefix)
 return {
 conversationId: `${seed}-conv`,
 requestId: `${seed}-req`,
 messageId: `${seed}-msg`,
 }
}

/**
 *一次「桌面端成功对话」的完整事件链（agent_task_created → chat_message_send →
 * chat_request_send → chat_message_response(isSuccessful) → chat_message_status →
 * chat_request_response）。
 *
 *实测该链点亮 RichMeow_Chat；template_5 / playbook_prompt / create_canvas / expert类
 *都在这条链上追加各自判据事件。
 */
export function desktopChatSequence(
 conversationId: string,
 requestId: string,
 messageId: string,
 modelId = FAST_MODEL,
 modelName = FAST_MODEL,
): UpstreamEvent[] {
 const assistantMessageId = `${messageId}-assistant`
 const now = Date.now()
 const mk = (eventCode: string, extra: UpstreamEvent = {}): UpstreamEvent => ({
 eventCode,
 ...extra,
 })
 return [
 mk("agent_task_created", {
 source: "LOCAL",
 name: "working",
 task_target: "local",
 mode: "craft",
 requestModelId: modelId,
 requestModelName: modelName,
 has_repo: false,
 repo_type: "none",
 workspace_type: "empty",
 has_connector: false,
 connector_types: [],
 has_mention: false,
 mention_types: [],
 has_template: false,
 action: "",
 template_name: "",
 has_expert: false,
 expert_id: "",
 expert_name: "",
 expert_industry_id: "",
 has_skill: false,
 skill_names: [],
 conversationId,
 messageId,
 buddyId: "",
 buddyName: "",
 }),
 mk("chat_message_send", {
 messageId: assistantMessageId,
 historyCount:0,
 isContextTruncated: false,
 currentStepCount:1,
 traceId: requestId,
 rootRequestId: requestId,
 parentConversationId: conversationId,
 agentName: "cli",
 agentType: "main",
 }),
 mk("chat_request_send", {
 inputLength:24,
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
 agentName: "cli",
 agentType: "main",
 "codebuddy.session_id": conversationId,
 "codebuddy.conversation_request_id": requestId,
 }),
 mk("chat_message_response", {
 messageId: assistantMessageId,
 responseModelId: modelId,
 inputToken:120,
 outputToken:80,
 totalToken:200,
 cachedTokens:0,
 cachedWriteTokens:0,
 cachedMissTokens:0,
 isSuccessful: true,
 messageErrorCode: "",
 finishReason: "stop",
 firstTokenAt: now,
 traceId: requestId,
 conversationId,
 rootRequestId: requestId,
 parentConversationId: conversationId,
 agentName: "cli",
 agentType: "main",
 "codebuddy.session_id": conversationId,
 "codebuddy.conversation_request_id": requestId,
 }),
 mk("chat_message_status", {
 messageId: assistantMessageId,
 messageErrorCode: "0",
 traceId: requestId,
 rootRequestId: requestId,
 parentConversationId: conversationId,
 agentName: "cli",
 agentType: "main",
 }),
 mk("chat_request_response", {
 mode: "craft",
 toolCallCount:0,
 inputToken:120,
 outputToken:80,
 totalToken:200,
 cachedTokens:0,
 cachedWriteTokens:0,
 cachedMissTokens:0,
 isSuccessful: true,
 messageErrorCode: "",
 finishReason: "stop",
 rootRequestId: requestId,
 parentConversationId: conversationId,
 }),
 ]
}

/**
 * 「进入 Buddy应用」五连事件（实测两账号纯 API点亮 Buddy_App与 Buddy_App_QQ）：
 * discover → show → enter_click → auth_confirm → bindaccount_skip。
 */
export function desktopBuddyAppSequence(
 buddyId = BUDDY_APP_ID,
 buddyName = BUDDY_APP_NAME,
): UpstreamEvent[] {
 const mk = (eventCode: string, extra: UpstreamEvent = {}): UpstreamEvent => ({
 eventCode,
 mode: "LOCAL",
 buddyId,
 buddyName,
 ...extra,
 })
 return [
 mk("buddyapp_discover_click"),
 mk("buddyapp_show", { elementId: buddyId, elementName: buddyName, position:2 }),
 mk("buddyapp_enter_click", {
 elementId: buddyId,
 elementName: buddyName,
 position:2,
 isFirstPage: "1",
 }),
 mk("buddyapp_auth_confirm_click", { elementId: buddyId, elementName: buddyName }),
 mk("buddyapp_bindaccount_skip_click", { elementId: buddyId, elementName: buddyName }),
 ]
}

/** 「定时任务创建成功」事件（实测点亮 automation_1）。 */
export function desktopAutomationCreateEvent(name: string): UpstreamEvent {
 return {
 eventCode: "automated_task_create_suc",
 name,
 source: "manually",
 modelId: FAST_MODEL,
 modelIsThinking: true,
 connectorCount:0,
 skills: "",
 skillCount:0,
 scheduleType: "once",
 mode: "LOCAL",
 }
}

/**
 * 「使用模板创建任务」事件组（实测 template_5计数）：
 * agent_task_created_with_template + template_used，JOIN一条完整 chat链。
 * template_id服务端不校验真实性。
 */
export function desktopTemplateUseSequence(
 conversationId: string,
 requestId: string,
 templateId: string,
 templateName: string,
): UpstreamEvent[] {
 return [
 ...desktopChatSequence(conversationId, requestId, `msg-${templateId}`, FAST_MODEL, FAST_MODEL),
 {
 eventCode: "agent_task_created_with_template",
 mode: "working",
 isCustomModel: false,
 id: templateId,
 name: templateName,
 requestId,
 },
 { eventCode: "template_used", template_id: templateId, task_mode: "working" },
 ]
}

/**
 * 「灵感案例做同款」事件组（实测 playbook_prompt计数）：
 * web_element_click(playbook_ctaClick) + playbook_cta_click + playbook_prompt_send。
 */
export function desktopPlaybookPromptSequence(
 conversationId: string,
 requestId: string,
 caseId: string,
 caseName: string,
): UpstreamEvent[] {
 const payload: UpstreamEvent = {
 id: caseId,
 name: caseName,
 type: "document",
 categoryId: "",
 categoryName: "",
 }
 return [
 ...desktopChatSequence(conversationId, requestId, "msg-pb", FAST_MODEL, FAST_MODEL),
 {
 eventCode: "web_element_click",
 pageName: "playbook_detail",
 elementId: "playbook_ctaClick",
 elementName: caseName,
 source: "discover",
 },
 { eventCode: "playbook_cta_click", source: "discover", position:0, ...payload },
 { eventCode: "playbook_prompt_send", conversationId, requestId, ...payload },
 ]
}

/**
 * 「设计创意画布」事件组（实测 create_canvas计数，+300分）：
 * wbx_design_canvas_task_create + wbx_design_canvas_open。
 */
export function desktopDesignCanvasSequence(
 conversationId: string,
 requestId: string,
): UpstreamEvent[] {
 return [
 ...desktopChatSequence(conversationId, requestId, "msg-canvas", FAST_MODEL, FAST_MODEL),
 {
 eventCode: "wbx_design_canvas_task_create",
 conversationId,
 requestId,
 source: "summon_keyword",
 cost:12_000,
 isSuccessful: true,
 },
 {
 eventCode: "wbx_design_canvas_open",
 conversationId,
 requestId,
 id: `ardot-file-${requestId.slice(-8)}`,
 source: "summon_keyword",
 type: "page",
 cost:13_000,
 isSuccessful: true,
 },
 ]
}

/**专家市场条目（`/portal/operation-platform/market/expert/list`响应子集）。 */
export interface MarketExpert {
 expertId: string
 expertType: string
 displayName: string
 profession: string
 version: string
 categories: string[]
}

/**拉取专家市场真实专家列表（expertType: `agent`单专家 / `team`专家团）。 */
export async function fetchMarketExperts(
 account: WorkbuddyAccount,
 expertType?: string,
): Promise<MarketExpert[]> {
 const base = realmBase(account)
 const body: Record<string, unknown> = {
 page:1,
 page_size:20,
 sort_by: "reco_rank",
 sort_order: "desc",
 }
 if (expertType) body.expert_type = expertType

 const record = await taskFetch(
 account,
 `${base.chat}/portal/operation-platform/market/expert/list`,
 { method: "POST", fingerprint: "desktop", body },
 "拉取专家列表",
 )
 const data = (record.data ?? {}) as Record<string, unknown>
 const experts = Array.isArray(data.experts) ? data.experts : []
 const result: MarketExpert[] = []
 for (const entry of experts) {
 if (!entry || typeof entry !== "object") continue
 const item = entry as Record<string, unknown>
 const expertId = typeof item.expert_id === "string" ? item.expert_id : ""
 if (!expertId) continue
 result.push({
 expertId,
 expertType: typeof item.expert_type === "string" ? item.expert_type : "agent",
 displayName: typeof item.display_name_zh === "string" ? item.display_name_zh : "",
 profession: typeof item.profession_zh === "string" ? item.profession_zh : "",
 version: typeof item.version === "string" ? item.version : "",
 categories: Array.isArray(item.categories)
 ? item.categories.filter((value): value is string => typeof value === "string")
 : [],
 })
 }
 return result
}

/**专家分类兜底值（无 categories时对齐实测样本）。 */
function expertCategory(expert: MarketExpert) {
 return expert.categories[0] || "expert-all"
}

/**「召唤平台专家」事件组（expert_summon_click / expert_summoned等）。 */
export function desktopExpertSummonSequence(expert: MarketExpert): UpstreamEvent[] {
 const version = expert.version || "1.0.0"
 return [
 {
 eventCode: "web_element_click",
 source: expert.expertId,
 type: expertCategory(expert),
 version,
 elementId: "expert_summon_click",
 elementName: "立即召唤",
 pageURL:
 "/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html",
 },
 {
 eventCode: "expert_summon_click",
 id: expert.expertId,
 name: expert.displayName,
 expertTitle: expert.profession,
 type: "expert-all",
 position:0,
 expertType: expert.expertType,
 version,
 mode: "LOCAL",
 },
 {
 eventCode: "expert_summoned",
 id: expert.expertId,
 name: expert.displayName,
 expertTitle: expert.profession,
 type: "expert-all",
 },
 ]
}

/**
 * 「专家真实使用」事件（expert_5 / Expert_team_use_3计数）。
 *
 * requestId必须是 `desktopChatWithExpert`返回的**服务端** id——自造 UUID不计数
 * （客户端 `resolveRealRequestId`同款语义）。
 */
export function desktopExpertActualUseEvent(
 expert: MarketExpert,
 conversationId: string,
 requestId: string,
 mode: "craft" | "LOCAL" = "craft",
): UpstreamEvent {
 return {
 eventCode: "expert_actual_use",
 id: expert.expertId,
 name: expert.displayName,
 expertTitle: expert.profession,
 type: expertCategory(expert),
 expertType: expert.expertType,
 source: "builtin",
 version: expert.version || "1.0.0",
 cost:9000,
 characterCount:14,
 mode,
 conversationId,
 requestId,
 messageId: `msg-${requestId.slice(-8)}`,
 requestModelId: FAST_MODEL,
 requestModelName: FAST_MODEL,
 }
}

/**服务端 requestId形状（`cmb-`前缀32hex或裸32hex）。 */
const REQUEST_ID_PATTERN = /^(cmb-)?[0-9a-f]{32}$/

/**
 *发一条真实桌面指纹 chat请求（可带 `X-Expert-Id`），从 SSE流解析**服务端返回的
 * requestId**（`data.id`）。
 *
 * expert_actual_use / skill_info类 JOIN事件的 requestId必须是服务端 id。
 */
export async function desktopChatWithExpert(
 account: WorkbuddyAccount,
 expertId: string,
 model = FAST_MODEL,
): Promise<{ conversationId: string; requestId: string }> {
 const base = realmBase(account)
 const conversationId = uniqueId("wb-conv")
 const headers: Record<string, string> = {
 authorization: `Bearer ${account.accessToken}`,
 "content-type": "application/json",
 accept: "text/event-stream",
 "user-agent": DESKTOP_UA,
 "x-domain": base.chat,
 "x-product": "SaaS",
 "x-conversation-id": conversationId,
 "x-request-id": `${Date.now()}`,
 "x-agent-intent": "craft",
 "x-agent-type": "main",
 "x-ide-name": "WorkBuddy",
 "x-ide-type": "WorkBuddy",
 "x-ide-version": "5.5.6",
 "x-codebuddy-request": "1",
 }
 if (account.uid) headers["x-user-id"] = account.uid
 if (expertId) headers["x-expert-id"] = expertId

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
 stream_options: { include_usage: true },
 }),
 })
 if (!response.ok) {
 const text = await response.text()
 throw new Error(`对话失败：HTTP ${response.status} ${text.trim().slice(0,180)}`)
 }
 const reader = response.body?.getReader()
 if (!reader) throw new Error("对话失败：上游没有返回流")

 let buffer = ""
 let requestId = ""
 try {
 while (!requestId) {
 const { done, value } = await reader.read()
 if (done) break
 buffer += new TextDecoder().decode(value, { stream: true })
 const match = buffer.match(/"id":"([^"]+)"/)
 if (match && REQUEST_ID_PATTERN.test(match[1])) {
 requestId = match[1]
 break
 }
 if (buffer.length >1_048_576) break
 }
 } finally {
 await reader.cancel().catch(() => undefined)
 }
 if (!requestId) throw new Error("SSE中未找到服务端 requestId")
 return { conversationId, requestId }
 } finally {
 clearTimeout(timeout)
 }
}

/**设置外观主题（`{chat}/v2/user-asset/appearance/set`）。 */
export async function setAppearanceTheme(
 account: WorkbuddyAccount,
 resourceKey: string,
): Promise<void> {
 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.chat}/v2/user-asset/appearance/set`,
 {
 method: "POST",
 fingerprint: "desktop",
 body: { kind: "theme", resource_key: resourceKey },
 },
 "设置外观主题",
 )
}

/** `appearance_skin_apply`事件（判据：客户端在主题生效状态下离开设置页）。 */
export function desktopAppearanceApplyEvent(resourceKey: string): UpstreamEvent {
 return {
 eventCode: "appearance_skin_apply",
 action: "apply",
 source: "settings_close",
 id: resourceKey,
 vipLevel:0,
 series: "",
 type: "unknown",
 }
}

/**上报一组桌面事件（供动作实现直接调用）。 */
export async function sendDesktopEvents(
 account: WorkbuddyAccount,
 events: UpstreamEvent[],
): Promise<void> {
 await reportDesktopEvents(account, events)
}
