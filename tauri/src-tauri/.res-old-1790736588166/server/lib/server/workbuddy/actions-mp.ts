import "server-only"

import type { WorkbuddyAccount } from "./account"
import { uniqueId } from "./api-client"
import {
 desktopAutomationCreateEvent,
 desktopPlaybookPromptSequence,
 fetchMarketExperts,
 newDesktopChatIds,
 sendDesktopEvents,
} from "./desktop-events"
import {
 mpChatModelEvent,
 mpChatRequestEvent,
 mpExpertUseEvent,
 mpPlaybookEvents,
 schoolSeasonChatEvent,
} from "./mp-events"
import { reportChatActivity, reportDesktopEvents, reportMpEvents } from "./report"
import {
 acceptWithVerifyMp,
 claimTaskFor,
 findTaskMp,
 MP_ACTION_GAP_MS,
 sleep,
 taskProgressText,
} from "./task-query"
import type { WorkbuddyGrowthTask } from "./task-api"

/**
 *小程序口径（growth域 `X-Client-Platform: miniprogram`）任务动作实现。
 *
 *全部按 `workbuddy2api-panel`（GitHub开源项目）实测口径照搬：
 * - school_season：accept → mini对话 + `activityId=school_open_day_2026` →领奖；
 * - Sequential_Tasks_1 /_3：accept → mini对话 ×target（按差额补报）→领奖；
 * - Sequential_Tasks_2：市场真实专家 id → accept → `expert_actual_use`（mp指纹）→领奖；
 * - Sequential_Tasks_4 /_5 /_7：预留链（每日零点解锁一环），判据形态待解锁校正。
 */

/**按差额补报 mini对话事件并回读；达标即领奖。 */
async function runMpMiniChatTask(
 account: WorkbuddyAccount,
 taskCode: string,
 eventFactory: (conversationId: string) => Record<string, unknown>,
): Promise<string> {
 let task = await findTaskMp(account, taskCode)
 if (!task) return "mp口径未下发该任务（活动可能已结束）"
 if (task.claimed) return "已领取"

 let target = task.target >0 ? task.target :1
 if (task.current >= target || task.acceptStatus === "completed") {
 const claim = await claimTaskFor(account, taskCode)
 return `已领取奖励（+${claim.credit}c +${claim.energy}e）`
 }
 if (task.acceptStatus === "not_accepted" || task.acceptStatus === "") {
 if (!(await acceptWithVerifyMp(account, taskCode))) {
 return "accept未登记生效（上游200+OK但未落账形态），待下次重试"
 }
 // accept后 target可能才下发（未 accept时 progress为 null）。
 task = (await findTaskMp(account, taskCode).catch(() => undefined)) ?? task
 if (task.target >0) target = task.target
 }

 const need = Math.max(0, target - task.current)
 for (let index =0; index < need; index++) {
 const conversationId = uniqueId(`wb-mp-${taskCode}`)
 try {
 await reportMpEvents(account, [eventFactory(conversationId)])
 } catch (error) {
 return `完成 ${index}/${need}次上报后中断：${error instanceof Error ? error.message : String(error)}`
 }
 await sleep(MP_ACTION_GAP_MS)
 }

 const after = await pollMpTask(account, taskCode, target)
 if (after?.claimed) return "本轮已入账（claimed）"
 if (!after || after.current < target) {
 return `已上报 ${need}次但进度未达 ${taskProgressText(after)}（异步计分未归账，下次重试）`
 }
 const claim = await claimTaskFor(account, taskCode)
 return `任务点亮并领取奖励（+${claim.credit}c +${claim.energy}e）`
}

/** mp任务达标回读（两轮各隔3秒，紧凑版异步计分预算）。 */
async function pollMpTask(
 account: WorkbuddyAccount,
 taskCode: string,
 target: number,
): Promise<WorkbuddyGrowthTask | undefined> {
 let task: WorkbuddyGrowthTask | undefined
 for (let round =0; round <2; round++) {
 await sleep(3_000)
 const next = await findTaskMp(account, taskCode).catch(() => undefined)
 if (!next) continue
 task = next
 if (task.claimable || task.claimed || task.current >= target) return task
 }
 return task ?? (await findTaskMp(account, taskCode).catch(() => undefined))
}

/**完成 school_season「校园日」。 */
export function runSchoolSeason(account: WorkbuddyAccount): Promise<string> {
 return runMpMiniChatTask(account, "school_season", schoolSeasonChatEvent)
}

/**完成 Sequential_Tasks_1「小程序内完成1次有效对话」。 */
export function runSequentialChat(account: WorkbuddyAccount): Promise<string> {
 return runMpMiniChatTask(account, "Sequential_Tasks_1", mpChatRequestEvent)
}

/**完成 Sequential_Tasks_3「在小程序内完成5次有效对话」。 */
export function runSequentialChat5(account: WorkbuddyAccount): Promise<string> {
 return runMpMiniChatTask(account, "Sequential_Tasks_3", mpChatRequestEvent)
}

/**完成 Sequential_Tasks_6「在小程序内完成10次有效对话」（预留）。 */
export function runSequentialChat10(account: WorkbuddyAccount): Promise<string> {
 return runMpMiniChatTask(account, "Sequential_Tasks_6", mpChatRequestEvent)
}

/**
 *完成 Sequential_Tasks_2「在小程序内选中专家并完成有效对话」。
 *
 *专家 id必须是市场真实 `ex_` id（空 id服务端不入账）→**accept之前**先解析市场列表：
 *拉不到就整任务不动作，避免留下「已登记未上报」的半程态。
 */
export async function runMiniExpert(account: WorkbuddyAccount): Promise<string> {
 const taskCode = "Sequential_Tasks_2"
 let task = await findTaskMp(account, taskCode)
 if (!task) return "mp口径未下发该任务（活动可能已结束）"
 if (task.claimed) return "已领取"

 let target = task.target >0 ? task.target :1
 if (task.current >= target || task.acceptStatus === "completed") {
 const claim = await claimTaskFor(account, taskCode)
 return `已领取奖励（+${claim.credit}c +${claim.energy}e）`
 }

 const experts = await fetchMarketExperts(account, "").catch(() => [])
 if (!experts.length) return "专家市场不可用，跳过以防半程态"
 const expert = experts[0]
 const name = expert.displayName || expert.profession

 if (task.acceptStatus === "not_accepted" || task.acceptStatus === "") {
 if (!(await acceptWithVerifyMp(account, taskCode))) {
 return "accept未登记生效（上游200+OK但未落账形态），待下次重试"
 }
 task = (await findTaskMp(account, taskCode).catch(() => undefined)) ?? task
 if (task.target >0) target = task.target
 }

 await reportMpEvents(account, [mpExpertUseEvent(expert.expertId, name, expert.expertType)])
 const after = await pollMpTask(account, taskCode, target)
 if (after?.claimed) return "本轮已入账（claimed）"
 if (!after || after.current < target) return "已上报但进度未归账（异步计分，下次重试）"
 const claim = await claimTaskFor(account, taskCode)
 return `任务点亮并领取奖励（+${claim.credit}c +${claim.energy}e）`
}

/**
 * Sequential链预留任务通用骨架：accept（带验证）→判据事件上报（primary；未点亮且
 * fallback非空时补一轮）→回读 →达标领奖。
 *每日零点解锁一环：locked期间 accept不落账，返回等下次调度。
 */
async function runSequentialEventTask(
 account: WorkbuddyAccount,
 taskCode: string,
 primary: () => Promise<void>,
 fallback?: () => Promise<void>,
): Promise<string> {
 let task = await findTaskMp(account, taskCode)
 if (!task) return "mp口径未下发该任务（前置任务未完成或活动未开始）"
 if (task.claimed) return "已领取"

 let target = task.target >0 ? task.target :1
 if (task.current >= target || task.acceptStatus === "completed") {
 const claim = await claimTaskFor(account, taskCode)
 return `已领取奖励（+${claim.credit}c +${claim.energy}e）`
 }
 if (task.acceptStatus === "not_accepted" || task.acceptStatus === "") {
 if (!(await acceptWithVerifyMp(account, taskCode))) {
 return "accept未登记生效（任务可能处于每日锁定窗口，等解锁后自动重试）"
 }
 task = (await findTaskMp(account, taskCode).catch(() => undefined)) ?? task
 if (task.target >0) target = task.target
 }

 await primary()
 for (let round =0; round <2; round++) {
 await sleep(3_000)
 const next = await findTaskMp(account, taskCode).catch(() => undefined)
 if (!next) continue
 task = next
 if (task.claimable || task.claimed || task.current >= target) break
 if (round ===0 && fallback) await fallback()
 }
 if (task.claimed) return "本轮已入账（claimed）"
 if (task.current < target) return "已上报但进度未点亮（判据形态待解锁后校正，下次重试）"
 const claim = await claimTaskFor(account, taskCode)
 return `任务点亮并领取奖励（+${claim.credit}c +${claim.energy}e）`
}

/**完成 Sequential_Tasks_4「创建定时任务」（预留，判据疑为 PC口径）。 */
export function runSequentialAutomation(account: WorkbuddyAccount): Promise<string> {
return runSequentialEventTask(account, "Sequential_Tasks_4", async () => {
await reportDesktopEvents(account, [desktopAutomationCreateEvent("wb2api自动化")])
})
}

/**完成 Sequential_Tasks_5「使用 GLM5.2」（预留）。 */
export function runSequentialModelChat(account: WorkbuddyAccount): Promise<string> {
 return runSequentialEventTask(
 account,
 "Sequential_Tasks_5",
async () => {
await reportMpEvents(account, [mpChatModelEvent(uniqueId("wb-mp-glm"), "glm-5.2", "GLM-5.2")])
},
async () => {
await reportChatActivity(account, uniqueId("wb-mp-glm"), "", "glm-5.2", "GLM-5.2")
},
)
}

/**完成 Sequential_Tasks_7「体验灵感功能」（预留，疑 PC口径 +500c+5e）。 */
export function runSequentialPlaybook(account: WorkbuddyAccount): Promise<string> {
 const caseId = "pm-gtm-launch-plan"
 const caseName = "新产品上市 GTM发布计划一页纸"
 return runSequentialEventTask(
 account,
"Sequential_Tasks_7",
async () => {
const ids = newDesktopChatIds("wb-pb-seq")
await sendDesktopEvents(
 account,
 desktopPlaybookPromptSequence(ids.conversationId, ids.requestId, caseId, caseName),
 )
 },
 async () => {
 await reportMpEvents(account, mpPlaybookEvents(caseId, caseName))
 },
 )
}
