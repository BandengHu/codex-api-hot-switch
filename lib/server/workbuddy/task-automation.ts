import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
acceptGrowthTasks,
 fetchGrowthStreak,
claimGrowthReward,
listGrowthTasks,
reportChatActivity,
 type WorkbuddyGrowthTask,
} from "./task-api"

/**
 * WorkBuddy 成长任务自动化。
 *
 * 按 `workbuddy2api-panel`（GitHub 开源项目）的实测口径实现。任务计分走 `/v2/report`
 * 行为上报；不同任务认不同客户端指纹。这里只做纯 API 能做的部分：
 * - chat_5 / first_buddy / Model_chat_GLM5.2：活跃上报（真实对话类任务由
 * `runModelChatTask` 用真实 chat请求走一遍）
 * - RichMeow_Chat / Buddy_App / automation_1 / Library_read / template_5等桌面
 *指纹事件链：本版先只覆盖上报型 +领奖，桌面事件链后续单独补
 * - 所有任务：accept →推进度 →轮询达标 →领奖
 *
 *领奖走 Web域 `POST /activity/growth/tasks/<code>/claim`（workbuddy2api-panel
 *实测：CLI域的 reward/claim 不存在，之前400 是端点选错了）。
 */

const REPORT_GAP_MS =1_050
const CHAT5_MIN_GAP_MS =1_100
const CLAIM_POLL_ATTEMPTS =4
const CLAIM_POLL_GAP_MS =3_000

export interface AutomationStepResult {
 taskCode: string
 status: "done" | "error" | "skipped"
 message: string
 credit?: number
 energy?: number
 claimed?: boolean
}

function sleep(ms: number) {
 return new Promise((resolve) => setTimeout(resolve, ms))
}

async function findTask(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<WorkbuddyGrowthTask | undefined> {
 const tasks = await listGrowthTasks(account)
 return tasks.find((task) => task.taskCode === taskCode)
}

async function findTaskWaiting(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<WorkbuddyGrowthTask | undefined> {
 let task = await findTask(account, taskCode)
 if (task?.claimable) return task
 for (let attempt =1; attempt < CLAIM_POLL_ATTEMPTS; attempt++) {
 await sleep(CLAIM_POLL_GAP_MS)
 task = await findTask(account, taskCode)
 if (task?.claimable) return task
 }
 return task
}

async function acceptIfPossible(account: WorkbuddyAccount, taskCode: string) {
 try {
 await acceptGrowthTasks(account, [taskCode])
 await sleep(REPORT_GAP_MS)
 } catch {
 // accept 已接受时上游返回成功或业务提示，不视为致命错误。
 }
}

async function tryClaim(
 account: WorkbuddyAccount,
 taskCode: string,
 result: AutomationStepResult,
) {
 try {
 const claim = await claimGrowthReward(account, taskCode)
 if (claim.alreadyClaimed) {
 result.message += "；奖励此前已领取"
 } else {
 result.claimed = true
 result.credit = claim.credit
 result.energy = claim.energy
 result.message += `；已领奖 +${claim.credit} 分 +${claim.energy} 能`
 }
 } catch (error) {
 result.message += `；领奖失败：${error instanceof Error ? error.message : String(error)}`
 }
}

/**
 *完成单个任务：accept →执行动作 →轮询达标 →领奖。
 *
 * action 为空时只做 accept +领奖（适用于已经达标但还没领的账号）。
 */
export async function runTaskAutomation(
 account: WorkbuddyAccount,
 taskCode: string,
 action?: () => Promise<void>,
): Promise<AutomationStepResult> {
 const result: AutomationStepResult = { taskCode, status: "error", message: "" }
 let task: WorkbuddyGrowthTask | undefined
 try {
 task = await findTask(account, taskCode)
 } catch (error) {
 result.message = `查询任务失败：${error instanceof Error ? error.message : String(error)}`
 return result
 }
 if (!task) {
 result.status = "skipped"
 result.message = "该账号没有这个任务"
 return result
 }
 if (task.claimed) {
 result.status = "skipped"
 result.message = "已领取"
 return result
 }
 if (task.locked) {
 result.status = "skipped"
 result.message = "任务未解锁"
 return result
 }

 await acceptIfPossible(account, taskCode)

 if (action) {
 try {
 await action()
 } catch (error) {
 result.message = `动作执行失败：${error instanceof Error ? error.message : String(error)}`
 return result
 }
 }

 task = await findTaskWaiting(account, taskCode)
 if (!task) {
 result.message = "轮询后任务消失"
 return result
 }
 if (!task.claimable) {
 result.status = "done"
 result.message = `进度未达标（${task.current}/${task.target}），请稍后手动重试`
 return result
 }

 result.status = "done"
 result.message = `进度达标（${task.current}/${task.target}）`
 await tryClaim(account, taskCode, result)
 return result
}

/**
 * chat_5：按差额上报 `chat_request_send`活跃事件。
 */
export async function runChat5Automation(account: WorkbuddyAccount): Promise<AutomationStepResult> {
return runTaskAutomation(account, "chat_5", async () => {
 const task = await findTask(account, "chat_5")
 if (!task) throw new Error("任务不存在")
 const target = task.target ||5
 const need = Math.max(0, target - task.current)

 for (let i =0; i < need; i++) {
 const conversationId = `wb2api-chat5-${Date.now()}-${i}`
 await reportChatActivity(account, conversationId, conversationId)
 if (i < need -1) await sleep(CHAT5_MIN_GAP_MS)
}
})
}

/**
 * first_buddy：活跃上报解锁前置 →领养协议由用户在桌面端点（本版不代点）
 * → 达标后领奖。如果上游要求领养协议，这里会停在「进度未达标」。
 */
export async function runFirstBuddyAutomation(account: WorkbuddyAccount): Promise<AutomationStepResult> {
 return runTaskAutomation(account, "first_buddy", async () => {
 const cid = `wb-pool-adopt-${account.uid}-${Date.now()}`
 await reportChatActivity(account, cid, `${cid}-req`)
 await sleep(REPORT_GAP_MS)
 })
}

/**
 *批量跑所有可自动化任务（不包含真实对话类——那个后续单独接）。
 * 单项失败不影响后续项。
 */
export async function runAllAutomations(
 account: WorkbuddyAccount,
): Promise<AutomationStepResult[]> {
 const results: AutomationStepResult[] = []
 for (const runner of [runChat5Automation, runFirstBuddyAutomation]) {
 try {
 results.push(await runner(account))
 } catch (error) {
 results.push({
 taskCode: runner.name,
 status: "error",
 message: error instanceof Error ? error.message : String(error),
 })
 }
 await sleep(REPORT_GAP_MS)
 }
 return results
}
