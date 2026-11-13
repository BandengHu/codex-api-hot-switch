import "server-only"

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hotSwitchDataDir } from "@/lib/server/state-store"
import { isRetryableWorkbuddyTaskError } from "./api-client"
import {
  dailyRunNeedsRetry,
  runDailyRewards,
  type DailyCheckinConfirmation,
  type DailyRunResult,
} from "./daily-automation"
import { runNightOwl, type NightOwlResult } from "./night-owl"
import { isNightWindow, nightOwlShouldRun } from "./workbuddy-time"
import { sleep } from "./task-query"
import { tryLockTaskAccount, unlockTaskAccount } from "./task-lock"
import {
  listPoolEntries,
  readPoolAccount,
  syncPoolFromDisk,
  type WorkbuddyPoolEntry,
} from "./task-pool-store"

export interface DailyScheduleState {
  version: 4
  /**CST 自然日；永久失败当天不再自动执行。 */
  lastRunByUid: Record<string, string>
  lastResultByUid?: Record<string, string>
  /** 到期后才补跑；未到期前不重复打上游。ISO 时间。 */
  nextRetryAtByUid?: Record<string, string>
  /** 当前连续待重试次数；下轮据此从 10 分钟延长到 40 分钟。 */
  retryCountByUid?: Record<string, number>
  /** 当日官方签到确认；缺失表示未知，不能当成未签到或已签到。 */
  checkinByUid?: Record<string, DailyCheckinConfirmation & { day: string }>
  /** 夜猫子最近一次成功上报对应的上海“晚”键，防止跨午夜重复计数。 */
  nightOwlByUid?: Record<string, string>
}

export interface DailySchedulerCycleResult {
  checked: number
  ran: Array<{ uid: string; result: string }>
  locked: string[]
}

const SCHEDULE_INTERVAL_MS = 60 * 1000
const STARTUP_DELAY_MS = 30 * 1000
const ACCOUNT_GAP_MS = 1000
const RESULT_PREVIEW_LIMIT = 300
const FIRST_RETRY_MS = 10 * 60 * 1000
const SECOND_RETRY_MS = 40 * 60 * 1000

function scheduleDir() {
  return join(hotSwitchDataDir(), "workbuddy-pool")
}

function schedulePath() {
  return join(scheduleDir(), "daily-schedule.json")
}

export function formatScheduleDay(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value)
}

export function normalizeDailyScheduleState(value: unknown): DailyScheduleState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 4, lastRunByUid: {} }
  }
  const raw = value as Record<string, unknown>
  const version = raw.version
  if (version !== 2 && version !== 3 && version !== 4) {
    return { version: 4, lastRunByUid: {} }
  }
  const normalizeMap = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
    const output: Record<string, string> = {}
    for (const [uid, text] of Object.entries(input as Record<string, unknown>)) {
      if (uid && typeof text === "string" && text.trim()) output[uid] = text.trim()
    }
    return output
  }
  const lastRunByUid = normalizeMap(raw.lastRunByUid) ?? {}
  const lastResultByUid = normalizeMap(raw.lastResultByUid)
  const nextRetryAtByUid = normalizeMap(raw.nextRetryAtByUid) ?? {}
  const retryCountByUid = normalizeCountMap(raw.retryCountByUid)
  const checkinByUid = normalizeCheckinMap(raw.checkinByUid)
  const nightOwlByUid = normalizeMap(raw.nightOwlByUid)
  if (version === 2) {
    const legacyPending = raw.retryPendingByUid
    const pendingEntries =
      legacyPending && typeof legacyPending === "object" && !Array.isArray(legacyPending)
        ? Object.entries(legacyPending as Record<string, unknown>)
        : []
    for (const [uid, pending] of pendingEntries) {
      if (pending === true && lastRunByUid[uid] && !nextRetryAtByUid[uid]) {
        nextRetryAtByUid[uid] = new Date().toISOString()
      }
    }
  }
  return {
    version: 4,
    lastRunByUid,
    ...(lastResultByUid ? { lastResultByUid } : {}),
    ...(Object.keys(nextRetryAtByUid).length ? { nextRetryAtByUid } : {}),
    ...(Object.keys(retryCountByUid).length ? { retryCountByUid } : {}),
    ...(Object.keys(checkinByUid).length ? { checkinByUid } : {}),
    ...(nightOwlByUid && Object.keys(nightOwlByUid).length
      ? { nightOwlByUid }
      : {}),
  }
}

function normalizeCountMap(input: unknown) {
  const output: Record<string, number> = {}
  if (!input || typeof input !== "object" || Array.isArray(input)) return output
  for (const [uid, value] of Object.entries(input as Record<string, unknown>)) {
    if (!uid || typeof value !== "number" || !Number.isInteger(value) || value <= 0) continue
    output[uid] = value
  }
  return output
}

function normalizeCheckinMap(input: unknown) {
  const output: Record<string, DailyCheckinConfirmation & { day: string }> = {}
  if (!input || typeof input !== "object" || Array.isArray(input)) return output
  for (const [uid, value] of Object.entries(input as Record<string, unknown>)) {
    if (!uid || !value || typeof value !== "object" || Array.isArray(value)) continue
    const item = value as Record<string, unknown>
    const day = typeof item.day === "string" ? item.day.trim() : ""
    const checkedAt = typeof item.checkedAt === "string" ? item.checkedAt.trim() : ""
    if (!day || !checkedAt) continue
    output[uid] = {
      day,
      checkedAt,
      todayCheckedIn:
        item.todayCheckedIn === true || item.todayCheckedIn === false
          ? item.todayCheckedIn
          : null,
      ...(Number.isFinite(item.todayCredit) && Number(item.todayCredit) >= 0
        ? { todayCredit: Number(item.todayCredit) }
        : {}),
      ...(Number.isFinite(item.streakDays) && Number(item.streakDays) >= 0
        ? { streakDays: Number(item.streakDays) }
        : {}),
    }
  }
  return output
}

export async function readDailyScheduleState(): Promise<DailyScheduleState> {
  try {
    const raw = await readFile(schedulePath(), "utf8")
    return normalizeDailyScheduleState(JSON.parse(raw))
  } catch {
    return { version: 4, lastRunByUid: {} }
  }
}

export async function writeDailyScheduleState(state: DailyScheduleState) {
  const normalized = normalizeDailyScheduleState(state)
  await mkdir(scheduleDir(), { recursive: true })
  const tempPath = `${schedulePath()}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
  await rename(tempPath, schedulePath())
}

/**挑出今天未运行或已到补跑时间的可用账号；禁用账号不参与自动化。 */
export function pickAccountsNeedingRun(
  entries: WorkbuddyPoolEntry[],
  state: DailyScheduleState,
  today = formatScheduleDay(new Date()),
  now = Date.now(),
) {
  return entries.filter((entry) => {
    if (entry.disabled) return false
    if (state.lastRunByUid[entry.uid] !== today) return true
    const retryAt = Date.parse(state.nextRetryAtByUid?.[entry.uid] ?? "")
    return Number.isFinite(retryAt) && retryAt <= now
  })
}

export function summarizeDailyRun(result: DailyRunResult) {
  const errors = result.steps.filter((step) => step.status === "error")
  const parts = [
    result.creditTotal > 0 ? `入账 +${result.creditTotal}分` : "无新增积分",
    ...(result.streakDays ? [`连登 ${result.streakDays}天`] : []),
    ...(errors.length
      ? [`异常 ${errors.length}项：${errors.map((step) => `${step.label} ${step.message}`).join("；")}`]
      : []),
    ...(dailyRunNeedsRetry(result) ? ["等待自动重试"] : []),
  ]
  const text = parts.join("；")
  return Array.from(text).slice(0, RESULT_PREVIEW_LIMIT).join("")
}

export function summarizeNightOwlRun(result: NightOwlResult) {
  return truncateResult(result.message)
}

/**记录结果和结构化待重试状态；非瞬时错误当天不重复。 */
export async function recordDailyRun(uid: string, result: DailyRunResult) {
  const state = await readDailyScheduleState()
  await writeDailyScheduleState(updateDailyRunState(
    state,
    uid,
    summarizeDailyRun(result),
    dailyRunNeedsRetry(result),
    formatScheduleDay(new Date()),
    Date.now(),
    result.checkin,
  ))
}

export async function recordNightOwlRun(uid: string, day: string) {
  const state = await readDailyScheduleState()
  await writeDailyScheduleState({
    ...state,
    nightOwlByUid: {
      ...(state.nightOwlByUid ?? {}),
      [uid]: day,
    },
  })
}

export function clearNightOwlRun(state: DailyScheduleState, uid: string): DailyScheduleState {
  const nightOwlByUid = { ...state.nightOwlByUid }
  delete nightOwlByUid[uid]
  const { nightOwlByUid: _nightOwlByUid, ...rest } = state
  return {
    ...rest,
    ...(Object.keys(nightOwlByUid).length ? { nightOwlByUid } : {}),
  }
}

export function updateDailyRunState(
  state: DailyScheduleState,
  uid: string,
  summary: string,
  retryable: boolean,
  day = formatScheduleDay(new Date()),
  now = Date.now(),
  checkin?: DailyCheckinConfirmation,
): DailyScheduleState {
  const nextRetryAtByUid = { ...(state.nextRetryAtByUid ?? {}) }
  const retryCountByUid = { ...(state.retryCountByUid ?? {}) }
  const checkinByUid = { ...(state.checkinByUid ?? {}) }
  if (retryable) {
    const retryCount = (retryCountByUid[uid] ?? 0) + 1
    retryCountByUid[uid] = retryCount
    const delay = retryCount > 1 ? SECOND_RETRY_MS : FIRST_RETRY_MS
    nextRetryAtByUid[uid] = new Date(now + delay).toISOString()
  } else {
    delete nextRetryAtByUid[uid]
    delete retryCountByUid[uid]
  }
  if (checkin) checkinByUid[uid] = { ...checkin, day }
  else if (checkinByUid[uid]?.day !== day) delete checkinByUid[uid]
  return {
    version: 4,
    lastRunByUid: { ...state.lastRunByUid, [uid]: day },
    lastResultByUid: { ...(state.lastResultByUid ?? {}), [uid]: summary },
    ...(Object.keys(nextRetryAtByUid).length ? { nextRetryAtByUid } : {}),
    ...(Object.keys(retryCountByUid).length ? { retryCountByUid } : {}),
    ...(Object.keys(checkinByUid).length ? { checkinByUid } : {}),
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function truncateResult(text: string) {
  return Array.from(text).slice(0, RESULT_PREVIEW_LIMIT).join("")
}

/**
 * 启动检查一次，之后每分钟检查到期账号。
 *
 *与手动「一键领积分」共用账号锁：拿不到锁就本轮跳过，等下一轮再查，绝不并发打上游。
 *每跑完一个账号就立刻落盘，进程重启也不会重复领取。
 */
export async function maybeRunDailyForAllAccounts(): Promise<DailySchedulerCycleResult> {
  const result: DailySchedulerCycleResult = { checked: 0, ran: [], locked: [] }
  await syncPoolFromDisk()
  const entries = await listPoolEntries()
  result.checked = entries.length

  let isFirstRun = true
  for (const entry of entries) {
    const now = Date.now()
    const today = formatScheduleDay(new Date(now))
    const state = await readDailyScheduleState()
    if (!pickAccountsNeedingRun([entry], state, today, now).length) continue
    if (!tryLockTaskAccount(entry.uid)) {
      result.locked.push(entry.uid)
      continue
    }

    if (!isFirstRun) await sleep(ACCOUNT_GAP_MS)
    isFirstRun = false
    try {
      let summary: string
      let dailyResult: DailyRunResult | undefined
      let runError: unknown
      try {
        const account = await readPoolAccount(entry.uid)
        dailyResult = await runDailyRewards(account)
      } catch (error) {
        runError = error
      }
      if (dailyResult) {
        summary = summarizeDailyRun(dailyResult)
        await recordDailyRun(entry.uid, dailyResult)
      } else {
        const retryable = isRetryableWorkbuddyTaskError(runError)
        summary = truncateResult(`执行失败：${errorText(runError)}${retryable ? "；等待自动重试" : ""}`)
        await recordDailyRunError(entry.uid, summary, retryable)
      }
      result.ran.push({ uid: entry.uid, result: summary })
    } finally {
      unlockTaskAccount(entry.uid)
    }
  }
  return result
}

/**
 * 夜猫子巡检独立于普通每日排程：普通任务一天只跑一次，而夜猫子只在
 * 23:00-08:00 开放，并且同一晚必须最多计数一次。
 */
export async function maybeRunNightOwlForAllAccounts(
  now = new Date(),
): Promise<DailySchedulerCycleResult> {
  const result: DailySchedulerCycleResult = { checked: 0, ran: [], locked: [] }
  if (!isNightWindow(now)) return result

  await syncPoolFromDisk()
  const entries = await listPoolEntries()
  result.checked = entries.length
  for (const entry of entries) {
    if (entry.disabled) continue
    const state = await readDailyScheduleState()
    if (!nightOwlShouldRun(now, state.nightOwlByUid?.[entry.uid])) continue
    if (!tryLockTaskAccount(entry.uid)) {
      result.locked.push(entry.uid)
      continue
    }
    try {
      const account = await readPoolAccount(entry.uid)
      const night: NightOwlResult = await runNightOwl(account, now)
      if (night.status === "done") {
        await recordNightOwlRun(entry.uid, night.key)
      }
      result.ran.push({ uid: entry.uid, result: summarizeNightOwlRun(night) })
    } catch (error) {
      const stateAfterFailure = await readDailyScheduleState()
      await writeDailyScheduleState(clearNightOwlRun(stateAfterFailure, entry.uid))
      result.ran.push({
        uid: entry.uid,
        result: truncateResult(`夜猫子执行失败：${errorText(error)}`),
      })
    } finally {
      unlockTaskAccount(entry.uid)
    }
  }
  return result
}

async function recordDailyRunError(uid: string, summary: string, retryable: boolean) {
  const state = await readDailyScheduleState()
  await writeDailyScheduleState(updateDailyRunState(state, uid, summary, retryable))
}

type SchedulerScope = typeof globalThis & {
  __codexHotSwitchDailySchedulerStarted?: boolean
  __codexHotSwitchDailySchedulerCycleRunning?: boolean
}

async function runSchedulerCycle() {
  const scope = globalThis as SchedulerScope
  if (scope.__codexHotSwitchDailySchedulerCycleRunning) return
  scope.__codexHotSwitchDailySchedulerCycleRunning = true
  try {
    await maybeRunDailyForAllAccounts()
    await maybeRunNightOwlForAllAccounts()
  } catch {
    //巡检失败不中断服务；下一分钟再检查到期状态。
  } finally {
    scope.__codexHotSwitchDailySchedulerCycleRunning = false
  }
}

export function startDailyScheduler() {
  const scope = globalThis as SchedulerScope
  if (scope.__codexHotSwitchDailySchedulerStarted) return
  scope.__codexHotSwitchDailySchedulerStarted = true

  const startupTimer = setTimeout(() => {
    void runSchedulerCycle()
  }, STARTUP_DELAY_MS)
  const intervalTimer = setInterval(() => {
    void runSchedulerCycle()
  }, SCHEDULE_INTERVAL_MS)
  startupTimer.unref?.()
  intervalTimer.unref?.()
}
