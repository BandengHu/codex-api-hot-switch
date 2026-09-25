import "server-only"

import type { WorkbuddyAccount } from "./account"
import { isGlobalAccount } from "./task-api"
import {
 adoptFirstBuddy,
 agreeBuddyTerms,
 claimCompensation,
 claimGift,
 claimTravel,
 dailyCheckin,
 departTravel,
 drawLottery,
 fetchBuddy,
 fetchLotteryChances,
 fetchStreakState,
 fetchTravelState,
 isAlreadyDoneError,
 missedYesterday,
 redeemStreakTier,
 useMakeupCard,
 yesterdayDay,
} from "./daily-api"

/**
 * 「每日领积分」一键编排。
 *
 * 顺序照搬 `workbuddy2api-panel`（GitHub开源项目）的签到排程：
 * 补签保连登 → 签到 → 礼包/补偿 → 连登兑换 → 抽奖 → 猫猫旅行。
 *
 * 每一步都幂等：上游对「已领过」返回业务错误，这里按 `isAlreadyDoneError` 记成
 * 「今天已领」而不是失败；未解锁档位（403）直接跳过。
 *
 * **不自动重试**：一次点到什么就是什么，失败原因原样回报给界面。
 */

export interface DailyStepResult {
 /**步骤标识（界面按此分组展示）。 */
 key: string
 label: string
 status: "done" | "skipped" | "error"
 message: string
 /**该步骤实际入账的积分（能取到时才有）。 */
 credit?: number
}

export interface DailyRunResult {
 steps: DailyStepResult[]
 /**本轮累计入账积分。 */
 creditTotal: number
 /**连登天数（拿到时才有）。 */
 streakDays?: number
}

export async function runDailyRewards(account: WorkbuddyAccount): Promise<DailyRunResult> {
 const steps: DailyStepResult[] = []
 const push = (step: DailyStepResult) => {
 steps.push(step)
 return step
 }
 const fail = (key: string, label: string, error: unknown) =>
 push({
 key,
 label,
 status: "error",
 message: error instanceof Error ? error.message : String(error),
 })

 // 国际站没有 CN 任务/签到体系（上游口径），不发起任何调用。
 if (isGlobalAccount(account)) {
 return {
 steps: [
 {
 key: "realm",
 label: "每日领积分",
 status: "skipped",
 message: "国际站账号没有签到与成长中心体系，无可领取项",
 },
 ],
 creditTotal:0,
 }
 }

 await stepMakeup(account, push, fail)
 await stepCheckin(account, push, fail)
 await stepGift(account, push, fail)
 await stepCompensation(account, push, fail)
 const streakDays = await stepStreak(account, push, fail)
 await stepLottery(account, push, fail)
 await stepTravel(account, push, fail)

 const creditTotal = steps.reduce((sum, step) => sum + (step.credit ??0),0)
 return { steps, creditTotal, ...(streakDays === undefined ? {} : { streakDays }) }
}

/**补签保连登：昨日漏签且有补签卡就补上（连登一断要重攒 7 天）。 */
async function stepMakeup(
 account: WorkbuddyAccount,
 push: (step: DailyStepResult) => DailyStepResult,
 fail: (key: string, label: string, error: unknown) => DailyStepResult,
) {
 const label = "补签"
 try {
 const missed = await missedYesterday(account)
 if (!missed) {
 push({ key: "makeup", label, status: "skipped", message: "昨日未漏签，无需补签" })
 return
 }
 const state = await fetchStreakState(account)
 if (state.makeupCards <=0) {
 push({ key: "makeup", label, status: "skipped", message: "昨日漏签但补签卡余额为0，跳过" })
 return
 }
 const date = yesterdayDay()
 await useMakeupCard(account, date)
 push({ key: "makeup", label, status: "done", message: `已用补签卡补 ${date}（保住连登）` })
 } catch (error) {
 fail("makeup", label, error)
 }
}

/**新手礼包（每号一次）。 */
async function stepGift(
 account: WorkbuddyAccount,
 push: (step: DailyStepResult) => DailyStepResult,
 fail: (key: string, label: string, error: unknown) => DailyStepResult,
) {
 const label = "新手礼包"
 try {
 const credit = await claimGift(account)
 push({ key: "gift", label, status: "done", message: `已领取新手礼包 +${credit}分`, credit })
 } catch (error) {
 if (isAlreadyDoneError(error)) {
 push({ key: "gift", label, status: "skipped", message: "已领过（每号限一次）" })
 return
 }
 fail("gift", label, error)
 }
}

/**每日签到。 */
async function stepCheckin(
 account: WorkbuddyAccount,
 push: (step: DailyStepResult) => DailyStepResult,
 fail: (key: string, label: string, error: unknown) => DailyStepResult,
) {
 const label = "每日签到"
 try {
 await dailyCheckin(account)
 push({ key: "checkin", label, status: "done", message: "签到成功" })
 } catch (error) {
 if (isAlreadyDoneError(error)) {
 push({ key: "checkin", label, status: "skipped", message: "今天已签到" })
 return
 }
 fail("checkin", label, error)
 }
}

/**活动补偿（有则领，通常无常驻活动）。 */
async function stepCompensation(
 account: WorkbuddyAccount,
 push: (step: DailyStepResult) => DailyStepResult,
 fail: (key: string, label: string, error: unknown) => DailyStepResult,
) {
 try {
 const credit = await claimCompensation(account)
 push({ key: "compensation", label: "活动补偿", status: "done", message: `已领取 +${credit}分`, credit })
 } catch (error) {
 if (isAlreadyDoneError(error)) {
 push({ key: "compensation", label: "活动补偿", status: "skipped", message: "当前无补偿活动" })
 return
 }
 fail("compensation", "活动补偿", error)
 }
}

/**连登兑换：把已解锁档位全兑换（locked/claimed 跳过）。 */
async function stepStreak(
 account: WorkbuddyAccount,
 push: (step: DailyStepResult) => DailyStepResult,
 fail: (key: string, label: string, error: unknown) => DailyStepResult,
): Promise<number | undefined> {
 const label = "连登兑换"
 let state: Awaited<ReturnType<typeof fetchStreakState>>
 try {
 state = await fetchStreakState(account)
 } catch (error) {
 fail("streak", label, error)
 return undefined
 }

 const redeemable = state.tiers.filter((tier) => tier.status !== "locked" && tier.status !== "claimed")
 if (!redeemable.length) {
 push({
 key: "streak",
 label,
 status: "skipped",
 message: `连登 ${state.days}天，暂无可兑换档位${state.nextTier ? `（距 ${state.nextTier} 还差 ${state.nextTierRemaining} 天）` : ""}`,
 })
 return state.days
 }

 const messages: string[] = []
 let credit =0
 for (const tier of redeemable) {
 try {
 await redeemStreakTier(account, tier.tier)
 credit += tier.credit
 messages.push(
 `${tier.tier}  +${tier.credit}分/${tier.energy}能量/${tier.cards}补签卡/${tier.chances}次抽奖`,
 )
 } catch (error) {
 // 未解锁（403）属预期：状态字段可能滞后，静默跳过。
 if (isAlreadyDoneError(error) || isForbidden(error)) continue
 messages.push(`${tier.tier} 失败：${error instanceof Error ? error.message : String(error)}`)
 }
 }
 push({
 key: "streak",
 label,
 status: messages.length ? "done" : "skipped",
 message: messages.length ? `已兑换：${messages.join("；")}` : `连登 ${state.days}天，档位暂不可兑`,
 ...(credit >0 ? { credit } : {}),
 })
 return state.days
}

/**抽奖：按当前次数抽完（次数只能由连登兑换获得）。 */
async function stepLottery(
 account: WorkbuddyAccount,
 push: (step: DailyStepResult) => DailyStepResult,
 fail: (key: string, label: string, error: unknown) => DailyStepResult,
) {
 const label = "抽奖"
 try {
 const chances = await fetchLotteryChances(account)
 if (chances <=0) {
 push({ key: "lottery", label, status: "skipped", message: "当前没有抽奖次数（需先兑换连登档位）" })
 return
 }
 const prizes: string[] = []
 for (let index =0; index < chances; index++) {
 prizes.push(await drawLottery(account))
 }
 push({ key: "lottery", label, status: "done", message: `已抽 ${chances}次：${prizes.join("；")}` })
 } catch (error) {
 fail("lottery", label, error)
 }
}

function isForbidden(error: unknown) {
 return error instanceof Error && error.message.includes("403")
}

/**
 * 猫猫旅行的单趟状态机（照搬参考项目的 travelOne）。
 *
 * 无猫 → 同意协议 + 领养；有猫 → 按状态分派：到站领奖 / 空闲派出 / 在途跳过。
 * 每次只推进一步，不轮询不等待——上游一趟要数小时，靠每天巡检自然闭环。
 */
async function stepTravel(
 account: WorkbuddyAccount,
 push: (step: DailyStepResult) => DailyStepResult,
 fail: (key: string, label: string, error: unknown) => DailyStepResult,
) {
 const label = "猫猫旅行"
 try {
 const buddy = await fetchBuddy(account)
 if (!buddy) {
 await agreeBuddyTerms(account)
 try {
 await adoptFirstBuddy(account)
 push({ key: "travel", label, status: "done", message: "已领养第一只猫猫（+300分）", credit: 300 })
 } catch (error) {
 // 门槛未达标（当日活跃上报不足）属预期，明天再试，不当失败。
 push({
 key: "travel",
 label,
 status: "skipped",
 message: `尚未达成领养条件，明天再试（${error instanceof Error ? error.message : String(error)}）`,
 })
 }
 return
 }

 const travel = await fetchTravelState(account)
 if (travel.state === "arrived") {
 if (travel.recordId === 0) {
 push({ key: "travel", label, status: "skipped", message: "已到站但没有记录 id，无法领奖" })
 return
 }
 const credit = await claimTravel(account, travel.recordId)
 push({ key: "travel", label, status: "done", message: `已领到站奖励 +${credit}分`, credit })
 return
 }

 if (travel.state === "idle") {
 if (travel.dailyLimitReached) {
 push({ key: "travel", label, status: "skipped", message: "今日已派出过，等明天" })
 return
 }
 await departTravel(account)
 push({ key: "travel", label, status: "done", message: `${buddy.name || "猫猫"}已出发旅行，等回来领奖` })
 return
 }

 if (travel.state === "traveling") {
 push({ key: "travel", label, status: "skipped", message: `${buddy.name || "猫猫"}还在路上，等回来再领` })
 return
 }

 push({ key: "travel", label, status: "skipped", message: `未知旅行状态「${travel.state}」，跳过` })
 } catch (error) {
 fail("travel", label, error)
 }
}
