import "server-only"

import type { WorkbuddyAccount } from "./account"
import { uniqueId, truncateStr } from "./api-client"
import { adoptFirstBuddy, agreeBuddyTerms, isBuddyTaskIncomplete } from "./buddy"
import {
 desktopAppearanceApplyEvent,
 desktopAutomationCreateEvent,
 desktopBuddyAppSequence,
 desktopChatSequence,
 desktopDesignCanvasSequence,
 desktopExpertActualUseEvent,
 desktopExpertSummonSequence,
 desktopPlaybookPromptSequence,
 desktopTemplateUseSequence,
 desktopChatWithExpert,
 fetchMarketExperts,
 HP_APPEARANCE_THEME,
 LIGHTHOUSE_EXPERT_ID,
 newDesktopChatIds,
 sendDesktopEvents,
 setAppearanceTheme,
 type MarketExpert,
} from "./desktop-events"
import { reportChatActivity, reportWebEvent } from "./report"
import { EXPERT_SUMMON_GAP_MS, findTask, REPORT_GAP_MS } from "./task-query"

/**
 *桌面 / web口径任务动作实现。
 *
 *全部按 `workbuddy2api-panel`（GitHub开源项目）实测口径照搬：
 * - RichMeow_Chat：桌面完整对话事件链（三账号实测点亮）；
 * - Buddy_App / Buddy_App_QQ：buddyapp五连事件（两账号实测）；
 * - automation_1：`automated_task_create_suc`（两账号实测）；
 * - Library_read：web域 `web_element_click(library_doc_intro_click)`（三账号实测）；
 * - template_5 / playbook_prompt / create_canvas：asar逆向判据事件（三账号实测）；
 * - expert_5 / Expert_team_use_3 / Expert_lighthouse：真实专家列表 +召唤链 +
 *真实 chat拿服务端 requestId + `expert_actual_use`；
 * - Hp_Appearance：`appearance/set`留痕 + `appearance_skin_apply`事件；
 * - skill_1：真实对话 + `skill_info`技能加载事件；
 * - Model_chat_GLM5.2：accept →真实 glm-5.2对话 →对齐模型上报。
 */

function sleep(ms: number) {
return new Promise((resolve) => setTimeout(resolve, ms))
}

/**完成 RichMeow_Chat（桌面端对话1次）。 */
export async function runRichMeow(account: WorkbuddyAccount): Promise<string> {
 const ids = newDesktopChatIds("wb-rm")
 await sendDesktopEvents(account, desktopChatSequence(ids.conversationId, ids.requestId, ids.messageId))
 return "已按桌面端指纹上报完整对话事件链（agent_task_created→chat_response）"
}

/**完成 Buddy_App / Buddy_App_QQ（进入 Buddy应用）。 */
export async function runBuddyApp(account: WorkbuddyAccount): Promise<string> {
 await sendDesktopEvents(account, desktopBuddyAppSequence())
 return "已上报 buddyapp进入五连事件（同时覆盖 Buddy_App与 Buddy_App_QQ）"
}

/**完成 automation_1（设置自动化任务）。 */
export async function runAutomationCreate(account: WorkbuddyAccount): Promise<string> {
 await sendDesktopEvents(account, [desktopAutomationCreateEvent("wb2api自动化")])
 return "已上报定时任务创建事件"
}

/**完成 Library_read（体验资料库）。 */
export async function runLibraryRead(account: WorkbuddyAccount): Promise<string> {
 const docUrl = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm"
 await reportWebEvent(account, "web_element_click", docUrl, "library_doc_intro_click", "WorkBuddy资料库介绍")
 return "已上报资料库介绍阅读事件"
}

/**完成 template_5（使用5个模板创建任务）。 */
export async function runTemplateUse(account: WorkbuddyAccount): Promise<string> {
 const templates: Array<[string, string]> = [
 ["1", "深度研究"],
 ["2", "周报生成"],
 ["3", "竞品分析"],
 ["4", "活动策划"],
 ["5", "代码评审"],
 ]
 for (const [index, template] of templates.entries()) {
 const ids = newDesktopChatIds(`wb-tpl-${index}`)
 const events = desktopTemplateUseSequence(ids.conversationId, ids.requestId, template[0], template[1])
 try {
 await sendDesktopEvents(account, events)
 } catch (error) {
 return `第 ${index +1}组模板事件上报失败：${error instanceof Error ? error.message : String(error)}`
 }
 await sleep(300)
 }
 return "已上报 template_used ×5"
}

/**完成 playbook_prompt（灵感案例 Dialog中发送 Prompt）。 */
export async function runPlaybookPrompt(account: WorkbuddyAccount): Promise<string> {
 const ids = newDesktopChatIds("wb-pb")
 await sendDesktopEvents(
 account,
 desktopPlaybookPromptSequence(
 ids.conversationId,
 ids.requestId,
 "pm-gtm-launch-plan",
 "新产品上市 GTM发布计划一页纸",
 ),
 )
 return "已上报 playbook_cta_click + playbook_prompt_send"
}

/**完成 create_canvas（设计创意模式创建画布，+300分）。 */
export async function runCreateCanvas(account: WorkbuddyAccount): Promise<string> {
 const ids = newDesktopChatIds("wb-canvas")
 await sendDesktopEvents(account, desktopDesignCanvasSequence(ids.conversationId, ids.requestId))
 return "已上报 wbx_design_canvas_task_create/open"
}

/**完成 Hp_Appearance（换主题）。 */
export async function runAppearance(account: WorkbuddyAccount): Promise<string> {
 await setAppearanceTheme(account, HP_APPEARANCE_THEME)
 await sleep(2_000)
 await sendDesktopEvents(account, [desktopAppearanceApplyEvent(HP_APPEARANCE_THEME)])
 return "已设置主题并上报皮肤生效事件"
}

/**
 *完成 skill_1（尝鲜热门技能）。
 *
 *判据：`skill_info`事件（桌面指纹）+ JOIN真实会话（服务端 conversationId/requestId）。
 */
export async function runSkillFresh(account: WorkbuddyAccount): Promise<string> {
 const { conversationId, requestId } = await desktopChatWithExpert(account, "")
 const messageId = `msg-${requestId.slice(-8)}`
 const events = desktopChatSequence(conversationId, requestId, messageId).map((event) =>
 event.eventCode === "chat_message_response" ? { ...event, finishReason: "tool_calls" } : event,
 )
 events.push({
 eventCode: "skill_info",
 id: "润泽小馆·日报撰写",
 skillId: "skill_2097350077599879168",
 skillVersion: "1.0.0",
 toolStatus: "success",
 fileCount:56,
 source: "workbuddy-desktop",
 conversationId,
 requestId,
 messageId,
 requestModelId: "fast-model",
 requestModelName: "fast-model",
 traceId: requestId,
 })
 await sendDesktopEvents(account, events)
 return "已上报真实对话 + skill_info技能加载事件"
}

/**
 *完成 Expert_lighthouse（体验「腾讯轻量云」专家）。
 *
 *与 expert_5同构，两处差异：chat链 `agent_task_created`需带 `has_expert:true` +
 * `expert_id`；`expert_actual_use`的 mode为 `LOCAL`（且 type为空、cost=0）。
 */
export async function runExpertLighthouse(account: WorkbuddyAccount): Promise<string> {
 let expert: MarketExpert = {
 expertId: LIGHTHOUSE_EXPERT_ID,
 expertType: "agent",
 displayName: "腾讯轻量云专家",
 profession: "腾讯轻量云专家",
 version: "1.0.2",
 categories: [],
 }
 const experts = await fetchMarketExperts(account, "agent").catch(() => [])
 const matched = experts.find((item) => item.expertId === LIGHTHOUSE_EXPERT_ID)
 if (matched) expert = matched

 await sendDesktopEvents(account, desktopExpertSummonSequence(expert))
 const { conversationId, requestId } = await desktopChatWithExpert(account, expert.expertId)
 const events = desktopChatSequence(conversationId, requestId, `msg-${requestId.slice(-8)}`).map((event) =>
 event.eventCode === "agent_task_created"
 ? {
 ...event,
 has_expert: true,
 expert_id: expert.expertId,
 expert_name: expert.displayName,
 expert_industry_id: "",
 }
 : event,
 )
 const usage = desktopExpertActualUseEvent(expert, conversationId, requestId, "LOCAL")
 usage.type = ""
 usage.cost =0
 events.push(usage)
 await sendDesktopEvents(account, events)
 return "已上报轻量云专家召唤+使用链（真实对话 requestId）"
}

/**完成 expert_5（使用5个平台专家）/ Expert_team_use_3（使用3个专家团）。 */
export async function runExpertBatch(
 account: WorkbuddyAccount,
 expertType: string,
 count: number,
): Promise<string> {
 const experts = await fetchMarketExperts(account, expertType)
 if (!experts.length) throw new Error("专家市场列表为空")
 let ok =0
 for (const [index, expert] of experts.entries()) {
 if (ok >= count) break
 try {
 await sendDesktopEvents(account, desktopExpertSummonSequence(expert))
 const { conversationId, requestId } = await desktopChatWithExpert(account, expert.expertId)
 const events = [
 ...desktopChatSequence(conversationId, requestId, `msg-${requestId.slice(-8)}`),
 desktopExpertActualUseEvent(expert, conversationId, requestId),
 ]
 await sendDesktopEvents(account, events)
 ok++
 } catch {
 //逐个继续：单个专家失败不影响后续。
 }
 if (index < experts.length -1) await sleep(EXPERT_SUMMON_GAP_MS)
 }
 return `已对 ${ok}位真实专家完成召唤+使用链（类型 ${expertType}）`
}

/**
 * chat_5：按差额上报 `chat_request_send`活跃事件。
 * （此动作在 task-actions.ts注册，这里导出实现便于复用。）
 */
export async function runChat5Action(account: WorkbuddyAccount): Promise<string> {
 const task = await findTask(account, "chat_5")
 if (!task) throw new Error("任务不存在")
 const target = task.target ||5
 const need = Math.max(0, target - task.current)
 if (need <=0) return "进度已达标，无需上报"
 for (let index =0; index < need; index++) {
 const conversationId = uniqueId("wb2api-chat5")
 try {
 await reportChatActivity(account, conversationId, conversationId)
 } catch (error) {
 return `上报第 ${index +1}/${need}条失败：${truncateStr(error instanceof Error ? error.message : String(error),160)}`
 }
 if (index < need -1) await sleep(1_100)
 }
 return `已补报 ${need}条对话事件`
}

/**
 * first_buddy：活跃上报解锁前置 →同意协议 →领养。
 *门槛未达标（上游要求当日活跃）返回提示，不算错误。
 */
export async function runFirstBuddyAction(account: WorkbuddyAccount): Promise<string> {
 const conversationId = uniqueId("wb2api-adopt")
 await reportChatActivity(account, conversationId, `${conversationId}-req`)
 await sleep(REPORT_GAP_MS)
 await agreeBuddyTerms(account)
 try {
 await adoptFirstBuddy(account)
 } catch (error) {
 if (isBuddyTaskIncomplete(error)) {
 return "前置已上报，但领养门槛未过（上游要求当日活跃），请稍后重试"
 }
 throw error
 }
 return "已领取 Buddy（+300分 +8能量）"
}

/**完成 Model_chat_GLM5.2：accept →真实对话 →对齐模型上报。 */
export async function runModelChat(account: WorkbuddyAccount): Promise<string> {
 const modelId = "glm-5.2"
 const modelName = "GLM-5.2"
 await desktopChatWithExpert(account, "", modelId)
 await sleep(REPORT_GAP_MS)
 const conversationId = uniqueId("wb2api-glm52")
 await reportChatActivity(account, conversationId, "", modelId, modelName)
 return "已完成 glm-5.2对话并上报"
}
