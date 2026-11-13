import "server-only"

import type { WorkbuddyAccount } from "./account"
import type { WorkbuddyDynamicExpert } from "@/lib/workbuddy-dynamic-expert"
import { resolveDynamicExpertTask, runDynamicExpert } from "./actions-experts"
import { findTaskAction, TASK_ACTIONS } from "./actions-registry"
import { runCampaignActions } from "./actions-campaign"
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
import { isMpTaskCode, listAllGrowthTasks } from "./task-api"

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

interface AutomationTaskOrder {
 taskCode: string
 taskType: string
}

/** auto 任务必须先于批量 accept 和其余任务执行，且只执行一次。 */
export function orderAutomationTaskCodes(tasks: AutomationTaskOrder[]) {
 const autoCodes = tasks
  .filter((task) => task.taskType.trim().toLowerCase() === "auto")
  .map((task) => task.taskCode)
 const autoSet = new Set(autoCodes)
 const others = TASK_ACTIONS
  .map((action) => action.taskCode)
  .filter((taskCode) => !autoSet.has(taskCode))
 return { autoCodes, otherCodes: others }
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
 let task: Awaited<ReturnType<typeof findTaskFor>>
 let dynamicExpert: WorkbuddyDynamicExpert | undefined
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

 const action = findTaskAction(taskCode)
 dynamicExpert = resolveDynamicExpertTask(task)
 if (!action && !dynamicExpert) {
  result.status = "skipped"
  result.message = "该任务需要客户端内交互（无对应接口），无法自动完成；请在官方客户端操作"
  return result
 }

// auto 类任务（例如 first_buddy）不接受接取，直接执行并领奖。
if (task.taskType.trim().toLowerCase() !== "auto") {
 await acceptTask(account, taskCode, isMpTaskCode(taskCode) ? "miniprogram" : undefined)
}

 try {
 result.message = action
  ? await action.run(account)
  : await runDynamicExpert(account, dynamicExpert!.expertId, dynamicExpert!.expertName)
 } catch (error) {
 result.status = "error"
 result.message = `动作执行失败：${error instanceof Error ? error.message : String(error)}`
 return result
 }

 task = isMpTaskCode(taskCode)
 ? await findTaskFor(account, taskCode).catch(() => undefined)
 : await findTaskWaiting(account, taskCode, dynamicExpert).catch(() => undefined)
if (!task) {
result.status = "done"
result.message += "；回读任务失败，请稍后确认"
  result.attempt = action?.attempt
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
 result.attempt = action?.attempt
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

 // auto 任务可能是 single 任务的前置，必须先完成并领奖。
 // first_buddy 的奖励会发放 Buddy 实例；顺序反了，后续 accept 会报
 // prerequisite not met: first_buddy。
 const initialTasks = await listAllGrowthTasks(account).catch((error: unknown) => {
  results.push({
   taskCode: "(读取任务)",
   status: "error",
   message: `读取成长任务失败（不阻塞后续）：${error instanceof Error ? error.message : String(error)}`,
  })
  return []
 })
 const { autoCodes, otherCodes } = orderAutomationTaskCodes(initialTasks)
 for (const taskCode of autoCodes) {
  try {
   results.push(await runTaskAutomation(account, taskCode))
  } catch (error) {
   results.push({
    taskCode,
    status: "error",
    message: error instanceof Error ? error.message : String(error),
   })
  }
  await sleep(REPORT_GAP_MS)
 }

 for (const message of await acceptAllPendingTasks(account).catch((error: unknown) => [
 `批量接受异常（不阻塞）：${error instanceof Error ? error.message : String(error)}`,
 ])) {
 results.push({ taskCode: "(批量接受)", status: "done", message })
 }

 for (const taskCode of otherCodes) {
 try {
   results.push(await runTaskAutomation(account, taskCode))
 } catch (error) {
 results.push({
    taskCode,
 status: "error",
 message: error instanceof Error ? error.message : String(error),
 })
 }
 await sleep(REPORT_GAP_MS)
 }

 // 静态动作表无法覆盖上游临时新增的专家任务；深链是唯一可靠判据。
 const liveTasks = await listAllGrowthTasks(account).catch(() => [])
 const knownCodes = new Set(TASK_ACTIONS.map((action) => action.taskCode))
 for (const task of liveTasks) {
  if (knownCodes.has(task.taskCode) || !resolveDynamicExpertTask(task)) continue
  try {
   results.push(await runTaskAutomation(account, task.taskCode))
  } catch (error) {
   results.push({
    taskCode: task.taskCode,
    status: "error",
    message: error instanceof Error ? error.message : String(error),
   })
  }
  await sleep(REPORT_GAP_MS)
 }

 // 运营活动走独立 portal 契约；成长任务列表失败/为空不能阻断这里。
 try {
  const campaignResults = await runCampaignActions(account)
  results.push(
   ...campaignResults.map((step) => ({
    taskCode: step.taskCode,
    status: step.status,
    message: step.message,
    ...(step.credit === undefined ? {} : { credit: step.credit }),
    ...(step.retryable ? { attempt: true } : {}),
   })),
  )
 } catch (error) {
  results.push({
   taskCode: "(运营活动)",
   status: "error",
   message: error instanceof Error ? error.message : String(error),
  })
 }

 return results
}
