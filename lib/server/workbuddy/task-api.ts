import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
asNumber,
realmBase,
taskFetch,
WorkbuddyTaskApiError,
} from "./api-client"

/**
 * WorkBuddy成长任务接口。
 *
 *端点与口径按 `workbuddy2api-panel`（GitHub开源项目）实测结论照搬：
 * -列表 / accept走 growth域（copilot.tencent.com），默认为「无端标记」口径；
 *小程序限定任务（school_season / Sequential_Tasks_*）只在 mp口径下发，
 *accept / claim同样要求 `X-Client-Platform: miniprogram`（缺头返回 task not found）；
 * -领奖走 Web域 `POST {web}/activity/growth/tasks/<code>/claim`（任务码在路径、无 body、
 *带 `x-client-platform: web`）；此前误用 CLI域 `reward/claim`长期400，已纠正。
 */

export { WorkbuddyTaskApiError }

/** mpPlatform小程序口径头值：小程序限定任务全链路要求该平台头。 */
export const MP_PLATFORM = "miniprogram"

/**小程序口径专属下发的成长任务（默认列表不出现）。新任务出现时在此登记。 */
const MP_TASK_CODES = new Set([
 "school_season",
 "Sequential_Tasks_1",
 "Sequential_Tasks_2",
 "Sequential_Tasks_3",
 "Sequential_Tasks_4",
 "Sequential_Tasks_5",
 "Sequential_Tasks_6",
 "Sequential_Tasks_7",
])

/**任务是否小程序口径专属（决定回读 / accept /领奖走 mp变体）。 */
export function isMpTaskCode(taskCode: string) {
 return MP_TASK_CODES.has(taskCode.trim())
}

export interface WorkbuddyGrowthTask {
 taskCode: string
 title: string
 description: string
 taskDesc: string
 rewardCredit: number
 rewardEnergy: number
 locked: boolean
 target: number
 current: number
 acceptStatus: string
 status: string
 claimable: boolean
 claimed: boolean
}

export async function fetchGrowthStreak(account: WorkbuddyAccount) {
 const base = realmBase(account)
 const record = await taskFetch(
 account,
 `${base.chat}/activity/growth/streak`,
 { method: "GET" },
 "查询连登状态",
 )
 const data = (record.data ?? {}) as Record<string, unknown>
 const streak = (data.streak ?? {}) as Record<string, unknown>
 return { days: asNumber(streak.days) ??0 }
}

/**
 *拉取任务列表。
 *
 * `platform: "miniprogram"`为小程序口径（实测是默认口径的超集，含常规任务 +
 *小程序专属任务），调用方合并时按 taskCode去重。
 */
export async function listGrowthTasks(
 account: WorkbuddyAccount,
 options: { platform?: "miniprogram" } = {},
): Promise<WorkbuddyGrowthTask[]> {
 const base = realmBase(account)
 const record = await taskFetch(
 account,
 `${base.chat}/v2/activity/growth/tasks`,
 { method: "GET", platform: options.platform },
 "获取任务列表",
 )
 const data = record.data as Record<string, unknown> | undefined
 const tasks = Array.isArray(data?.tasks) ? data.tasks : []
 const result: WorkbuddyGrowthTask[] = []

 for (const entry of tasks) {
 if (!entry || typeof entry !== "object") continue
 const item = entry as Record<string, unknown>
 const taskCode = typeof item.task_code === "string" ? item.task_code : ""
 if (!taskCode) continue

 const progress = asProgress(item.progress)
 const target = asNumber(item.target) ?? progress.target ??0
 const current = asNumber(item.current) ?? progress.current ??0
 const acceptStatus = typeof item.accept_status === "string" ? item.accept_status : ""
 const claimed = acceptStatus === "claimed"

 result.push({
 taskCode,
 title: typeof item.title === "string" ? item.title : taskCode,
 description: typeof item.description === "string" ? item.description : "",
 taskDesc: typeof item.task_desc === "string" ? item.task_desc : "",
 rewardCredit: asNumber(item.reward_credit) ??0,
 rewardEnergy: asNumber(item.reward_energy) ??0,
 locked: item.locked === true,
 target,
 current,
 acceptStatus,
 status: typeof item.status === "string" ? item.status : "",
 claimable: !claimed && target >0 && current >= target,
 claimed,
 })
 }

 return result
}

/**默认口径 +小程序口径合并列表（按 taskCode去重，默认口径优先）。 */
export async function listAllGrowthTasks(account: WorkbuddyAccount): Promise<WorkbuddyGrowthTask[]> {
 const merged: WorkbuddyGrowthTask[] = []
 const seen = new Set<string>()
 const collect = (tasks: WorkbuddyGrowthTask[]) => {
 for (const task of tasks) {
 if (seen.has(task.taskCode)) continue
 seen.add(task.taskCode)
 merged.push(task)
 }
 }

 collect(await listGrowthTasks(account))
 try {
 collect(await listGrowthTasks(account, { platform: "miniprogram" }))
 } catch {
 //小程序口径拉取失败不影响默认口径结果。
 }
 return merged
}

export async function acceptGrowthTasks(
 account: WorkbuddyAccount,
 taskCodes: string[],
 options: { platform?: "miniprogram" } = {},
) {
 if (!taskCodes.length) return

 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.chat}/v2/activity/growth/tasks/accept`,
 { method: "POST", body: { task_codes: taskCodes }, platform: options.platform },
 "接受任务",
 )
}

export interface ClaimResult {
 alreadyClaimed: boolean
 credit: number
 energy: number
}

function parseClaimData(data: unknown): ClaimResult {
 const record = (data ?? {}) as Record<string, unknown>
 return {
 alreadyClaimed: record.already_claimed === true,
 credit: asNumber(record.credit) ??0,
 energy: asNumber(record.energy) ??0,
 }
}

/**领奖（Web域；任务码在路径、无 body、`x-client-platform: web`）。 */
export async function claimGrowthReward(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<ClaimResult> {
 const base = realmBase(account)
 const url = `${base.web}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`
 const record = await taskFetch(
 account,
 url,
 { method: "POST", fingerprint: "web", platform: "web" },
 "领取奖励",
 )
 return parseClaimData(record.data)
}

/**
 *小程序限定任务领奖：先走 chat域 `/activity/growth/tasks/{code}/claim` + mp头，
 * chat域400时降级 Web域（上游 task_runner `claim_one(mp=True)`同款）。
 */
export async function claimGrowthRewardMp(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<ClaimResult> {
 const base = realmBase(account)
 const url = `${base.chat}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`
 try {
 const record = await taskFetch(
 account,
 url,
 { method: "POST", platform: MP_PLATFORM },
 "领取小程序任务奖励",
 )
 return parseClaimData(record.data)
 } catch (error) {
 if (error instanceof WorkbuddyTaskApiError && error.isBadRequest) {
 return claimGrowthReward(account, taskCode)
 }
 throw error
 }
}

export interface WorkbuddyBalance {
 remain: number
 used: number
 size: number
 packs: number
}

export async function fetchBalance(account: WorkbuddyAccount): Promise<WorkbuddyBalance> {
const base = realmBase(account)
 const path = isGlobalAccount(account)
 ? "/billing/meter/get-user-resource"
 : "/v2/billing/meter/get-user-resource"
 const record = await taskFetch(
 account,
 `${base.billing}${path}`,
 {
 method: "POST",
 body: {
 PageNumber:1,
 PageSize:100,
 ProductCode: "p_tcaca",
 Status: [0,3],
 PackageEndTimeRangeBegin: formatDateTime(new Date()),
 PackageEndTimeRangeEnd: formatDateTime(new Date(Date.now() +365 *100 *86_400_000)),
 },
 },
 "查询余额",
 )

 const data = record.data as Record<string, unknown> | undefined
 const response = data?.Response as Record<string, unknown> | undefined
 const responseData = response?.Data as Record<string, unknown> | undefined
 const accounts = Array.isArray(responseData?.Accounts) ? responseData.Accounts : []
 let remain =0
 let used =0
 let size =0

 for (const entry of accounts) {
 if (!entry || typeof entry !== "object") continue
 const pkg = entry as Record<string, unknown>
 const cycleSize = asNumber(pkg.CycleCapacitySize) ??0
 let packageRemain =0
 let packageUsed =0
 let packageSize =0

 if (cycleSize >0) {
 packageSize = cycleSize
 packageRemain = Math.min(Math.max(asNumber(pkg.CycleCapacityRemain) ??0,0), cycleSize)
 packageUsed = cycleSize - packageRemain
 const reportedUsed = asNumber(pkg.CycleCapacityUsed) ??0
 if (reportedUsed > packageUsed) {
 packageUsed = reportedUsed
 if (cycleSize >= packageUsed) packageRemain = cycleSize - packageUsed
 }
 } else {
 packageRemain = asNumber(pkg.CapacityRemain) ??0
 packageUsed = asNumber(pkg.CapacityUsed) ??0
 packageSize = asNumber(pkg.CapacitySize) ??0
 if (packageUsed ===0 && packageSize > packageRemain) {
 packageUsed = packageSize - packageRemain
 }
 }

 remain += packageRemain
 used += packageUsed
 size += packageSize
 }

 const totalDosage = asNumber(responseData?.TotalDosage) ??0
 if (totalDosage > size) {
 size = totalDosage
 used = Math.max(used, size - remain)
 }

 return { remain, used, size, packs: accounts.length }
}

export async function dailyCheckin(account: WorkbuddyAccount) {
 const base = realmBase(account)
 const path = isGlobalAccount(account)
 ? "/billing/meter/daily-checkin"
 : "/v2/billing/meter/daily-checkin"
 await taskFetch(account, `${base.billing}${path}`, { method: "POST", body: {} }, "每日签到")
}

export function isGlobalAccount(account: WorkbuddyAccount) {
 return account.domain.includes("workbuddy.ai")
}

function asProgress(progress: unknown): { current?: number; target?: number } {
 if (!progress || typeof progress !== "object") return {}
 const record = progress as Record<string, unknown>
 return { current: asNumber(record.current), target: asNumber(record.target) }
}

function formatDateTime(value: Date) {
 const pad = (number: number) => String(number).padStart(2, "0")
 const date = `${value.getFullYear()}-${pad(value.getMonth() +1)}-${pad(value.getDate())}`
 const time = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
 return `${date} ${time}`
}
