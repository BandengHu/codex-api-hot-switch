import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
 asNumber,
 realmBase,
 taskFetch,
 type TaskFetchInit,
 WorkbuddyTaskApiError,
} from "./api-client"

/**
 * WorkBuddy「每日领积分」接口族。
 *
 * 端点与口径按 `workbuddy2api-panel`（GitHub开源项目）实测结论照搬，并已在本机
 * 逐条实测（2026-09-25）：
 * - **签到 /礼包 /补偿** 走 billing域（`/billing/meter/*`，CN 带 `/v2` 前缀）；
 * - **连登兑换 /抽奖 /补签 /热力图** 走 growth域（`{chat}/activity/growth/*`）。
 *
 * 上游对「已领过」一律返回 HTTP 400 +业务 code 10001，属于**幂等成功**，调用方按
 * `isAlreadyDoneError` 静默跳过，不计失败。
 */

/**签到 /礼包 /补偿三类「已领过」文案（实测原文）。 */
const ALREADY_DONE_MARKERS = ["已签到", "已领取", "无法重复领取", "未开启", "已过期"]

const CHECKIN_PENDING_MARKERS = ["处理中", "请勿重复操作", "系统繁忙", "稍后再试"]
const CHECKIN_ALREADY_MARKERS = ["已签到"]
const CHECKIN_FAILED_MARKERS = ["失败"]

function dailyTaskFetch(
 account: WorkbuddyAccount,
 url: string,
 init: TaskFetchInit,
 context: string,
) {
 return taskFetch(account, url, { ...init, retry: true }, context)
}

/**
 * 判定错误是否为「今天已经领过了」这类幂等拒绝。
 *
 * 只认带 HTTP状态或业务 code 的**上游分类错误**：网络层/解析层错误不在此列，
 * 否则抖动会被当成「已领」，账号当天实际没签到却被记成正常。
 */
export function isAlreadyDoneError(error: unknown) {
 if (!(error instanceof WorkbuddyTaskApiError)) return false
 if (error.status === undefined && !error.message.includes("code=")) return false
 const text = `${error.message} ${serializePayload(error.payload)}`
 //「签到失败，已签到天数不足」同时含「已签到」，不能把失败回执当成已完成。
 if (CHECKIN_FAILED_MARKERS.some((marker) => text.includes(marker))) return false
 return ALREADY_DONE_MARKERS.some((marker) => text.includes(marker))
}

export type DailyCheckinState = "checked" | "already" | "pending" | "failed"

export interface DailyCheckinReceipt {
  state: DailyCheckinState
  credit: number
  /** 仅当上游回执明确带 credit 时才为 true。 */
  creditKnown: boolean
  streakDays?: number
  code?: number
  message: string
}

export interface DailyCheckinStatus {
  todayCheckedIn: boolean
  streakDays: number
  dailyCredit: number
  todayCredit: number
  active: boolean
}

/**
 * 签到回执分类。
 *
 * 顺序必须是 pending → failed → already → checked：
 * - pending 是明确没签成，不能写完成状态；
 * - failed 先于 already，避免“签到失败，已签到天数不足”被误判；
 * - code=0 且带“今天已签到”表示今天早已完成，不是本次新签到。
 */
export function classifyDailyCheckin(code: number | undefined, message: string): DailyCheckinState {
 const text = message.trim()
 if (CHECKIN_PENDING_MARKERS.some((marker) => text.includes(marker))) return "pending"
 if (CHECKIN_FAILED_MARKERS.some((marker) => text.includes(marker))) return "failed"
 if (CHECKIN_ALREADY_MARKERS.some((marker) => text.includes(marker))) return "already"
 return code === 0 || code === undefined ? "checked" : "failed"
}

function parsePayload(payload: unknown): Record<string, unknown> | undefined {
 if (payload && typeof payload === "object" && !Array.isArray(payload)) {
  return payload as Record<string, unknown>
 }
 if (typeof payload !== "string" || !payload.trim()) return undefined
 try {
  const parsed = JSON.parse(payload) as unknown
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
   ? parsed as Record<string, unknown>
   : undefined
 } catch {
  return undefined
 }
}

function serializePayload(payload: unknown) {
 if (typeof payload === "string") return payload
 if (payload && typeof payload === "object") return JSON.stringify(payload)
 return ""
}

function payloadText(record: Record<string, unknown> | undefined) {
 if (!record) return ""
 return typeof record.msg === "string"
  ? record.msg
  : typeof record.message === "string"
   ? record.message
   : ""
}

function receiptFromRecord(record: Record<string, unknown>): DailyCheckinReceipt {
 const data = (record.data ?? {}) as Record<string, unknown>
 const code = asNumber(record.code)
 const message = payloadText(record)
 const credit = asNumber(record.credit) ?? asNumber(data.credit)
 const streakDays = asNumber(record.streak_days) ?? asNumber(data.streak_days)
 return {
  state: classifyDailyCheckin(code, message),
  credit: credit ?? 0,
  creditKnown: credit !== undefined,
  ...(streakDays === undefined ? {} : { streakDays }),
  ...(code === undefined ? {} : { code }),
  message,
 }
}

/**
 * 国内签到。成功回执是平铺 `{credit, streak_days}`，不是 data 信封；
 * 不能因为没有 data.credit 就把本次真实入账记成 0。
 */
export async function dailyCheckin(account: WorkbuddyAccount): Promise<DailyCheckinReceipt> {
 const base = realmBase(account)
 const path = "/v2/billing/meter/daily-checkin"
 try {
  const record = await dailyTaskFetch(
    account,
    `${base.billing}${path}`,
    { method: "POST", body: {} },
    "每日签到",
  )
  return receiptFromRecord(record)
 } catch (error) {
  if (!(error instanceof WorkbuddyTaskApiError)) throw error
  const payload = parsePayload(error.payload)
  const code = asNumber(payload?.code) ?? asNumber(
   error.message.match(/\bcode=(\d+)\b/)?.[1],
  )
  const message = payloadText(payload) || (
   /已签到|处理中|请勿重复操作|系统繁忙|稍后再试|失败/.test(error.message)
    ? error.message
    : ""
  )
  if (error.status !== 400 && code === undefined && !message) throw error
  if (!message && code === undefined) throw error
  return {
   state: classifyDailyCheckin(code, message),
   credit: 0,
   creditKnown: false,
   ...(code === undefined ? {} : { code }),
   message,
  }
 }
}

/**
 * 国内官方签到状态。签到请求成功不等于积分到账，必须以这里的
 * `today_checked_in` / `today_credit` 作为确认事实。
 */
export async function fetchCheckinActivityStatus(
  account: WorkbuddyAccount,
): Promise<DailyCheckinStatus> {
  if (account.domain.includes("workbuddy.ai")) {
    throw new Error("国际站账号不支持国内签到状态查询")
  }
  const base = realmBase(account)
  const record = await dailyTaskFetch(
    account,
    `${base.chat}/v2/billing/meter/checkin-activity-status`,
    { method: "POST", body: {} },
    "查询签到状态",
  )
  const data = (record.data ?? {}) as Record<string, unknown>
  return {
    todayCheckedIn: data.today_checked_in === true,
    streakDays: asNumber(data.streak_days) ?? 0,
    dailyCredit: asNumber(data.daily_credit) ?? 0,
    todayCredit: asNumber(data.today_credit) ?? 0,
    active: data.active !== false,
  }
}

/**新手礼包（每号一次，已领返回幂等错误）。返回获得的积分。 */
export async function claimGift(account: WorkbuddyAccount): Promise<number> {
 const base = realmBase(account)
 const record = await dailyTaskFetch(
 account,
 `${base.billing}/billing/meter/claim-gift`,
 { method: "POST", body: {} },
 "领取新手礼包",
 )
 return asNumber((record.data as Record<string, unknown> | undefined)?.credit) ??0
}

/**活动补偿（有则领，无则幂等错误）。返回获得的积分。 */
export async function claimCompensation(account: WorkbuddyAccount): Promise<number> {
 const base = realmBase(account)
 const record = await dailyTaskFetch(
 account,
 `${base.billing}/billing/meter/claim-compensation`,
 { method: "POST", body: {} },
 "领取活动补偿",
 )
 return asNumber((record.data as Record<string, unknown> | undefined)?.credit) ??0
}

export interface StreakTier {
 tier: string
 days: number
 credit: number
 energy: number
 cards: number
 chances: number
 /** locked / claimed /可兑换（上游原文）。 */
 status: string
}

export interface StreakState {
 days: number
 nextTier: string
 nextTierRemaining: number
 makeupCards: number
 tiers: StreakTier[]
}

/**连登完整状态（growth域）：天数、补签卡余额、各档位可兑换状态。 */
export async function fetchStreakState(account: WorkbuddyAccount): Promise<StreakState> {
 const base = realmBase(account)
 const record = await dailyTaskFetch(
 account,
 `${base.chat}/activity/growth/streak`,
 { method: "GET" },
 "查询连登状态",
 )
 const data = (record.data ?? {}) as Record<string, unknown>
 const streak = (data.streak ?? {}) as Record<string, unknown>
 const cards = (data.makeup_cards ?? {}) as Record<string, unknown>
 const redemption = (data.redemption_status ?? {}) as Record<string, unknown>
 const statusByTier: Record<string, string> = {
 "7d": typeof redemption.tier_7d_status === "string" ? redemption.tier_7d_status : "",
 "14d": typeof redemption.tier_14d_status === "string" ? redemption.tier_14d_status : "",
 "28d": typeof redemption.tier_28d_status === "string" ? redemption.tier_28d_status : "",
 }
 const rawTiers = Array.isArray(redemption.tiers) ? redemption.tiers : []
 const tiers: StreakTier[] = []
 for (const entry of rawTiers) {
 if (!entry || typeof entry !== "object") continue
 const item = entry as Record<string, unknown>
 const tier = typeof item.tier === "string" ? item.tier : ""
 if (!tier) continue
 tiers.push({
 tier,
 days: asNumber(item.days) ??0,
 credit: asNumber(item.credit) ??0,
 energy: asNumber(item.energy) ??0,
 cards: asNumber(item.cards) ??0,
 chances: asNumber(item.chances) ??0,
 status: statusByTier[tier] ?? "",
 })
 }
 return {
 days: asNumber(streak.days) ??0,
 nextTier: typeof streak.next_tier === "string" ? streak.next_tier : "",
 nextTierRemaining: asNumber(streak.next_tier_remaining) ??0,
 makeupCards: asNumber(cards.balance) ??0,
 tiers,
 }
}

/**
 * 兑换连登档位。
 *
 * 未解锁时上游返回 HTTP 403「连续登录天数不足」，属预期分支，由调用方按 locked 跳过。
 */
export async function redeemStreakTier(account: WorkbuddyAccount, tier: string) {
 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.chat}/activity/growth/redeem`,
 { method: "POST", body: { tier, client_token: crypto.randomUUID() } },
 `兑换连登 ${tier}档`,
 )
}

/**当前抽奖次数（只能由连登兑换获得）。 */
export async function fetchLotteryChances(account: WorkbuddyAccount): Promise<number> {
 const base = realmBase(account)
 const record = await dailyTaskFetch(
 account,
 `${base.chat}/activity/growth/lottery/summary`,
 { method: "GET" },
 "查询抽奖次数",
 )
 const data = (record.data ?? {}) as Record<string, unknown>
 return asNumber(data.chances) ??0
}

/**抽奖一次，返回上游原始奖品载荷（形状随活动期变化，不做解析）。 */
export async function drawLottery(account: WorkbuddyAccount): Promise<string> {
 const base = realmBase(account)
 const record = await taskFetch(
 account,
 `${base.chat}/activity/growth/lottery/draw`,
 { method: "POST", body: { client_token: crypto.randomUUID() } },
 "抽奖",
 )
 return JSON.stringify(record.data ?? {}).slice(0,200)
}

/**昨日是否漏签（热力图 cell score==0）。 */
export async function missedYesterday(account: WorkbuddyAccount): Promise<boolean> {
 const base = realmBase(account)
 const record = await dailyTaskFetch(
 account,
 `${base.chat}/activity/growth/heatmap`,
 { method: "GET" },
 "查询签到热力图",
 )
 const data = (record.data ?? {}) as Record<string, unknown>
 const cells = Array.isArray(data.cells) ? data.cells : []
 const yesterday = formatDay(new Date(Date.now() -86_400_000))
 for (const entry of cells) {
 if (!entry || typeof entry !== "object") continue
 const cell = entry as Record<string, unknown>
 const date = typeof cell.date === "string" ? cell.date.slice(0,10) : ""
 if (date === yesterday) return (asNumber(cell.score) ??0) ===0
 }
 return false
}

/**对指定日期用补签卡（保住连登连续天数）。无卡时上游返回业务错误。 */
export async function useMakeupCard(account: WorkbuddyAccount, date: string) {
 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.chat}/activity/growth/makeup-cards/use`,
 { method: "POST", body: { target_date: date } },
 "使用补签卡",
 )
}

export interface BuddyInfo {
 instanceId: number
 name: string
 rarity: string
}

/**当前猫档案；`undefined` 表示无猫（上游 `data.buddy` 为 null）。 */
export async function fetchBuddy(account: WorkbuddyAccount): Promise<BuddyInfo | undefined> {
 const base = realmBase(account)
 const record = await dailyTaskFetch(
 account,
 `${base.chat}/activity/growth/buddy/info`,
 { method: "GET" },
 "查询猫档案",
 )
 const buddy = (record.data as Record<string, unknown> | undefined)?.buddy
 if (!buddy || typeof buddy !== "object") return undefined
 const item = buddy as Record<string, unknown>
 return {
 instanceId: asNumber(item.instance_id) ??0,
 name: typeof item.name === "string" ? item.name : "",
 rarity: typeof item.rarity === "string" ? item.rarity : "",
 }
}

/**同意 Buddy 协议（幂等，重复调用无副作用）。 */
export async function agreeBuddyTerms(account: WorkbuddyAccount) {
 const base = realmBase(account)
 await dailyTaskFetch(
 account,
 `${base.chat}/activity/growth/buddy/agreement`,
 { method: "POST", body: { agree: true } },
 "同意 Buddy 协议",
 )
}

/**领养第一只猫（需 first_buddy 任务已达标，否则上游 400）。 */
export async function adoptFirstBuddy(account: WorkbuddyAccount) {
 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.chat}/activity/growth/buddy/first`,
 { method: "POST", body: {} },
 "领养第一只猫",
 )
}

export interface TravelState {
 /**idle 可派出；traveling 在途；arrived 到站可领奖。 */
 state: string
 /**今日已派出过（自然日 00:00 CST 重置）。 */
 dailyLimitReached: boolean
 /**上游返回的在途/到站记录 id；仅用于诊断，官方领奖不依赖它。 */
 recordId: number
 /**到站可领的积分。 */
 rewardCredit: number
}

/**猫猫旅行状态（growth域）。 */
export async function fetchTravelState(account: WorkbuddyAccount): Promise<TravelState> {
 const base = realmBase(account)
 const record = await dailyTaskFetch(
 account,
 `${base.chat}/activity/growth/buddy/travel/status`,
 { method: "GET" },
 "查询猫猫旅行状态",
 )
 const data = (record.data ?? {}) as Record<string, unknown>
 return {
 state: typeof data.state === "string" ? data.state : "",
 dailyLimitReached: data.daily_limit_reached === true,
 recordId: asNumber(data.record_id) ??0,
 rewardCredit: asNumber(data.reward_credit) ??0,
 }
}

/**
 * 派出猫出去旅行。
 *
 * `locationId` 固定 4：上游 4 个地点的收益/时长区间完全相同，没有最优解。
 */
export async function departTravel(account: WorkbuddyAccount, locationId = 4) {
 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.chat}/activity/growth/buddy/travel/depart`,
 { method: "POST", body: { location_id: locationId } },
 "派出猫猫旅行",
 )
}

/**领取到站的旅行奖励，返回入账积分。官方前端发送空 body。 */
export async function claimTravel(account: WorkbuddyAccount): Promise<number> {
 const base = realmBase(account)
 const record = await taskFetch(
 account,
 `${base.chat}/activity/growth/buddy/travel/claim`,
 { method: "POST", body: {} },
 "领取旅行奖励",
 )
 return asNumber((record.data as Record<string, unknown> | undefined)?.reward_credit) ??0
}

/**昨日日期（上游按自然日 00:00 CST 重置，本机即 CST）。 */
export function yesterdayDay() {
 return formatDay(new Date(Date.now() -86_400_000))
}

function formatDay(value: Date) {
 const pad = (number: number) => String(number).padStart(2, "0")
 return `${value.getFullYear()}-${pad(value.getMonth() +1)}-${pad(value.getDate())}`
}
