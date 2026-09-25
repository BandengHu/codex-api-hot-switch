import "server-only"

import type { WorkbuddyAccount } from "./account"
import { findTaskAction, TASK_ACTIONS } from "./actions-registry"
import {
 acceptAllPendingTasks,
 acceptTask,
 claimTaskFor,
 findTaskFor,
 findTaskWaiting,
 REPORT_GAP_MS,
 sleep,
 taskProgressText,
} from "./task-query"
import { isMpTaskCode } from "./task-api"

/**
 * WorkBuddy成长任务自动化编排。
 *
 *按 `workbuddy2api-panel`（GitHub开源项目）口径照搬：任务计分走 `/v2/report`
 *行为上报，不同任务认不同客户端指纹；**上报200 ≠计分**，所以每个动作执行完都要
 *回读进度（有界轮询等异步计分落定），达标即自动领奖（Web域 `/claim`）。
 */

export interface AutomationStepResult {
taskCode: string
status: "done" | "error" | "skipped"
message: string
credit?: number
energy?: number
claimed?: boolean
progressBefore?: string
progressAfter?: string
 /** true =尝试型任务（上游未证实可脚本化）。 */
 attempt?: boolean
}

/**
 *完成单个任务：查任务 → accept →执行动作 →轮询达标 →领奖。
 *
 *任务无对应动作时返回 `skipped`（提示需在官方客户端交互）；已领取 /未解锁直接跳过。
 */
export async function runTaskAutomation(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<AutomationStepResult> {
 const result: AutomationStepResult = { taskCode, status: "error", message: "" }
 const action = findTaskAction(taskCode)
 if (!action) {
 result.status = "skipped"
 result.message = "该任务需要客户端内交互（无对应接口），无法自动完成；请在官方客户端操作"
 return result
 }

 let task: Awaited<ReturnType<typeof findTaskFor>>
 try {
 task = await findTaskFor(account, taskCode)
 } catch (error) {
 result.message = `查询任务失败：${error instanceof Error ? error.message : String(error)}`
 return result
 }
 if (!task) {
 result.status = "skipped"
 result.message = "该账号没有这个任务"
 return result
 }
 result.progressBefore = taskProgressText(task)
 if (task.claimed) {
 result.status = "skipped"
 result.message = "该任务已领取过奖励"
 return result
 }
 if (task.locked) {
 result.status = "skipped"
 result.message = "任务未解锁"
 return result
 }

 await acceptTask(account, taskCode, isMpTaskCode(taskCode) ? "miniprogram" : undefined)

 try {
 result.message = await action.run(account)
 } catch (error) {
 result.status = "error"
 result.message = `动作执行失败：${error instanceof Error ? error.message : String(error)}`
 return result
 }

 task = isMpTaskCode(taskCode)
 ? await findTaskFor(account, taskCode).catch(() => undefined)
 : await findTaskWaiting(account, taskCode).catch(() => undefined)
if (!task) {
result.status = "done"
result.message += "；回读任务失败，请稍后确认"
 result.attempt = action.attempt
return result
}
 result.progressAfter = taskProgressText(task)

 if (task.claimed) {
 result.status = "done"
 result.message += "；本轮已入账（claimed）"
 return result
 }
 if (!task.claimable) {
 result.status = "done"
 result.message += `；进度未达标（${taskProgressText(task)}），请稍后重试`
 result.attempt = action.attempt
 return result
 }

 result.status = "done"
 await tryClaim(account, taskCode, result)
 return result
}

async function tryClaim(
 account: WorkbuddyAccount,
 taskCode: string,
 result: AutomationStepResult,
) {
 try {
 const claim = await claimTaskFor(account, taskCode)
 if (claim.alreadyClaimed) {
 result.message += "；奖励此前已领取"
 return
 }
 result.claimed = true
 result.credit = claim.credit
 result.energy = claim.energy
 result.message += `；已自动领奖 +${claim.credit}分 +${claim.energy}能`
 } catch (error) {
 result.message += `；达标但领奖失败，可在任务列表手动重试：${
 error instanceof Error ? error.message : String(error)
 }`
 }
}

/**
 *一键完成该账号全部可自动任务。
 *
 *流程照搬上游：先把所有未接受的任务批量 accept（规范状态机），再逐项执行行为链路；
 *单项失败不影响后续项。
 */
export async function runAllAutomations(
 account: WorkbuddyAccount,
): Promise<AutomationStepResult[]> {
 const results: AutomationStepResult[] = []

 for (const message of await acceptAllPendingTasks(account).catch((error: unknown) => [
 `批量接受异常（不阻塞）：${error instanceof Error ? error.message : String(error)}`,
 ])) {
 results.push({ taskCode: "(批量接受)", status: "done", message })
 }

 for (const action of TASK_ACTIONS) {
 try {
 results.push(await runTaskAutomation(account, action.taskCode))
 } catch (error) {
 results.push({
 taskCode: action.taskCode,
 status: "error",
 message: error instanceof Error ? error.message : String(error),
 })
 }
 await sleep(REPORT_GAP_MS)
 }

 return results
}
