import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
 importPoolAccount,
 listPoolEntries,
  availableUidOfState,
  readPoolState,
  setActivePoolAccount,
 syncPoolFromDisk,
} from "@/lib/server/workbuddy/task-pool-store"
import { fetchBalance } from "@/lib/server/workbuddy/task-api"
import { activeRateLimitOf } from "@/lib/server/workbuddy/pool-selection"
import {
  formatScheduleDay,
  readDailyScheduleState,
} from "@/lib/server/workbuddy/daily-scheduler"
import { readPoolAccount } from "@/lib/server/workbuddy/task-pool-store"
import {
  summarizeWorkbuddyCreditsByUid,
  type WorkbuddyCreditSummariesByUid,
} from "@/lib/server/workbuddy/credit-ledger"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface PoolEntryWithBalance {
 uid: string
 nickname: string
 source: "local" | "file"
 disabled: boolean
 rateLimit?: { message: string; resetAt: string }
  recoveredRateLimit?: { message: string; resetAt: string }
 balance?: { remain: number; used: number; size: number; packs: number }
 balanceError?: string
 dailyStatus?: {
   lastRunDate: string
   lastResult?: string
   needsRun: boolean
   todayCheckedIn?: boolean | null
   todayCredit?: number
   streakDays?: number
   checkedAt?: string
 }
 creditUsageToday?: {
   recordedRequests: number
   knownCredits: number
   unknownCredits: number
   creditTotal: number
 }
}

export async function GET() {
 try {
 await syncPoolFromDisk()
 const entries = await listPoolEntries()
 const poolState = await readPoolState()
 const schedule = await readDailyScheduleState()
 const today = formatScheduleDay(new Date())
 const creditUsageByUid: WorkbuddyCreditSummariesByUid =
   await summarizeWorkbuddyCreditsByUid(today).catch(() => ({}))
 const enriched: PoolEntryWithBalance[] = []
 for (const entry of entries) {
 const item: PoolEntryWithBalance = {
 uid: entry.uid,
 nickname: entry.nickname,
 source: entry.source,
 disabled: entry.disabled,
 }
 const rateLimit = activeRateLimitOf(poolState, entry.uid)
 const previousRateLimit = poolState.rateLimits?.[entry.uid]
 if (rateLimit) item.rateLimit = rateLimit
 if (!rateLimit && previousRateLimit) {
   item.recoveredRateLimit = previousRateLimit
 }
 if (!entry.disabled) {
 try {
 const account = await readPoolAccount(entry.uid)
 const balance = await fetchBalance(account)
 item.balance = balance
 if (!item.nickname && account.nickname) item.nickname = account.nickname
 } catch (error) {
 item.balanceError = errorMessage(error)
 }
 }
  const lastRunDate = schedule.lastRunByUid[entry.uid]
  const lastResult = schedule.lastResultByUid?.[entry.uid]
  const rawCheckin = schedule.checkinByUid?.[entry.uid]
  const checkin = rawCheckin?.day === today ? rawCheckin : undefined
  const creditUsageToday = creditUsageByUid[entry.uid]
  const retryAt = Date.parse(schedule.nextRetryAtByUid?.[entry.uid] ?? "")
  if (creditUsageToday) item.creditUsageToday = creditUsageToday
  if (lastRunDate || lastResult || checkin) {
    item.dailyStatus = {
      lastRunDate: lastRunDate ?? "",
      lastResult,
      needsRun:
        lastRunDate !== today ||
        checkin?.todayCheckedIn !== true ||
        (Number.isFinite(retryAt) && retryAt <= Date.now()),
      todayCheckedIn: checkin?.todayCheckedIn,
      todayCredit: checkin?.todayCredit,
      streakDays: checkin?.streakDays,
      checkedAt: checkin?.checkedAt,
    }
 }
 enriched.push(item)
 }
 // 全部账号限频时仍返回列表；没有可转发账号就用空串表示。
 return NextResponse.json({
   entries: enriched,
   activeUid: availableUidOfState(poolState) ?? "",
 })
 } catch (error) {
 return jsonError(`读取号池失败：${errorMessage(error)}`)
 }
}

export async function POST(request: Request) {
 try {
 const body = await readJsonBody<{ credentials?: string; activeUid?: string }>(request)
 if (body.activeUid !== undefined) {
 const activeUid = await setActivePoolAccount(body.activeUid)
 return NextResponse.json({ ok: true, activeUid })
 }
 if (!body.credentials?.trim()) {
 return jsonError("缺少凭据内容",400)
 }
 const entry = await importPoolAccount(body.credentials.trim())
 return NextResponse.json({ ok: true, entry })
 } catch (error) {
 return jsonError(`导入失败：${errorMessage(error)}`,400)
 }
}
