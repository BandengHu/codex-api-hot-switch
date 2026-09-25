import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
 acceptGrowthTasks,
 claimGrowthReward,
 claimGrowthRewardMp,
 isMpTaskCode,
 listAllGrowthTasks,
 listGrowthTasks,
 MP_PLATFORM,
 type ClaimResult,
 type WorkbuddyGrowthTask,
} from "./task-api"

/**
 *任务查询 /接受 /领奖的公共动作层。
 *
 *口径照搬 `workbuddy2api-panel`（GitHub开源项目）：
 * -**异步计分**：行为事件上报后进度要数秒才刷新（实测约5-8秒），一次性回读会误判
 * 「未达标」从而跳过自动领奖，所以达标回读一律走**有界轮询**；
 * -**accept是报名**：不产生进度；已 accepted时上游返回成功或业务提示，均不视为
 *致命错误；
 * -**mp口径**：小程序专属任务在默认列表查不到，须回落 mp列表，accept/claim也
 *必须带 `X-Client-Platform: miniprogram`（缺头返回 task not found）。
 */

/**连续上报之间的间隔（对齐上游脚本实测的1.05s口径，避免风控）。 */
export const REPORT_GAP_MS =1_050
/** mp任务写动作间隔（accept /上报 /领奖之间，防频控）。 */
export const MP_ACTION_GAP_MS =2_000
/**达标回读的轮询次数与间隔（总预算约12秒）。 */
export const CLAIM_POLL_ATTEMPTS =4
export const CLAIM_POLL_GAP_MS =3_000
/**专家召唤链的间隔（真实使用节奏，实测6秒成功率100%）。 */
export const EXPERT_SUMMON_GAP_MS =6_000

export function sleep(ms: number) {
 return new Promise((resolve) => setTimeout(resolve, ms))
}

/**拉取任务列表并定位单个任务；压 mp专属码自动回落 mp列表。 */
export async function findTask(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<WorkbuddyGrowthTask | undefined> {
 const tasks = await listAllGrowthTasks(account)
 return tasks.find((task) => task.taskCode === taskCode)
}

/** mp口径任务列表定位（school_season / Sequential_Tasks_*）。 */
export async function findTaskMp(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<WorkbuddyGrowthTask | undefined> {
 const tasks = await listGrowthTasks(account, { platform: "miniprogram" })
 return tasks.find((task) => task.taskCode === taskCode)
}

/**按任务口径选择查询方式。 */
export function findTaskFor(account: WorkbuddyAccount, taskCode: string) {
 return isMpTaskCode(taskCode) ? findTaskMp(account, taskCode) : findTask(account, taskCode)
}

/**
 *回读任务，未达标则在有界预算内轮询等待（上游异步计分）。
 *已达标立即返回；预算耗尽返回最后一次结果。
 */
export async function findTaskWaiting(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<WorkbuddyGrowthTask | undefined> {
 let task = await findTaskFor(account, taskCode)
 if (!task || task.claimable || task.claimed) return task
 for (let attempt =1; attempt < CLAIM_POLL_ATTEMPTS; attempt++) {
 await sleep(CLAIM_POLL_GAP_MS)
 const next = await findTaskFor(account, taskCode).catch(() => undefined)
 if (!next) continue
 task = next
 if (task.claimable || task.claimed) return task
 }
 return task
}

/** accept（幂等：失败不阻塞——行为事件才是进度唯一判据）。 */
export async function acceptTask(
 account: WorkbuddyAccount,
 taskCode: string,
 platform?: "miniprogram",
): Promise<boolean> {
 try {
 await acceptGrowthTasks(account, [taskCode], platform ? { platform } : {})
 await sleep(REPORT_GAP_MS)
 return true
 } catch {
 return false
 }
}

/**
 * mp任务 accept并回读验证登记生效。
 *
 *上游存在「200+OK但 accept未真正登记」的形态（此时上报事件全部不归账，任务永远
 *点不亮），判定以回读 `accept_status`为准，未生效重试一次。
 */
export async function acceptWithVerifyMp(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<boolean> {
 for (let attempt =1; attempt <=2; attempt++) {
 try {
 await acceptGrowthTasks(account, [taskCode], { platform: "miniprogram" })
 } catch {
 continue
 }
 await sleep(MP_ACTION_GAP_MS)
 const task = await findTaskMp(account, taskCode).catch(() => undefined)
 if (task && task.acceptStatus !== "not_accepted" && task.acceptStatus !== "") return true
 }
 return false
}

/**按任务口径领奖（mp走 chat域 mp口径，其余走 Web域）。 */
export function claimTaskFor(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<ClaimResult> {
 return isMpTaskCode(taskCode)
 ? claimGrowthRewardMp(account, taskCode)
 : claimGrowthReward(account, taskCode)
}

/**任务进度的可读表示（回读对比用）。 */
export function taskProgressText(task: WorkbuddyGrowthTask | undefined): string {
 if (!task) return "?"
 if (task.target >0) return `${task.current}/${task.target}`
 if (task.claimed) return "claimed"
 return task.acceptStatus || "?"
}

/**批量接受账号下所有未接受任务（默认口径 + mp口径，失败不阻塞）。 */
export async function acceptAllPendingTasks(account: WorkbuddyAccount): Promise<string[]> {
 const messages: string[] = []
 const tasks = await listAllGrowthTasks(account).catch(() => [])
 const pending = tasks
 .filter((task) => !task.claimed && !task.locked && task.acceptStatus !== "accepted" && task.acceptStatus !== "completed")
 .map((task) => task.taskCode)
const normal = pending.filter((code) => !isMpTaskCode(code))
const mp = pending.filter((code) => isMpTaskCode(code))

if (normal.length) {
try {
await acceptGrowthTasks(account, normal)
messages.push(`已接受 ${normal.length}个任务`)
 } catch (error) {
 messages.push(`接受任务失败（不阻塞后续）：${error instanceof Error ? error.message : String(error)}`)
 }
 await sleep(REPORT_GAP_MS)
 }
 if (mp.length) {
 try {
 await acceptGrowthTasks(account, mp, { platform: MP_PLATFORM })
 messages.push(`已接受 ${mp.length}个小程序任务`)
 } catch (error) {
 messages.push(`接受小程序任务失败（不阻塞后续）：${error instanceof Error ? error.message : String(error)}`)
 }
 await sleep(REPORT_GAP_MS)
 }
 return messages
}
