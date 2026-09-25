import "server-only"

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hotSwitchDataDir } from "@/lib/server/state-store"
import type { DailyRunResult } from "./daily-automation"
import { runDailyRewards } from "./daily-automation"
import { sleep } from "./task-query"
import { tryLockTaskAccount, unlockTaskAccount } from "./task-lock"
import {
  listPoolEntries,
  readPoolAccount,
  syncPoolFromDisk,
  type WorkbuddyPoolEntry,
} from "./task-pool-store"

export interface DailyScheduleState {
  version: 1
  /**CST 自然日；同一天只自动跑一次，失败也不当日重试。 */
  lastRunByUid: Record<string, string>
  lastResultByUid?: Record<string, string>
}

export interface DailySchedulerCycleResult {
  checked: number
  ran: Array<{ uid: string; result: string }>
  locked: string[]
}

const SCHEDULE_INTERVAL_MS = 2 * 60 * 60 * 1000
const STARTUP_DELAY_MS = 30 * 1000
const ACCOUNT_GAP_MS = 1000
const RESULT_PREVIEW_LIMIT = 300

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
    return { version: 1, lastRunByUid: {} }
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) return { version: 1, lastRunByUid: {} }
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
  return {
    version: 1,
    lastRunByUid,
    ...(lastResultByUid ? { lastResultByUid } : {}),
  }
}

export async function readDailyScheduleState(): Promise<DailyScheduleState> {
  try {
    const raw = await readFile(schedulePath(), "utf8")
    return normalizeDailyScheduleState(JSON.parse(raw))
  } catch {
    return { version: 1, lastRunByUid: {} }
  }
}

export async function writeDailyScheduleState(state: DailyScheduleState) {
  const normalized = normalizeDailyScheduleState(state)
  await mkdir(scheduleDir(), { recursive: true })
  const tempPath = `${schedulePath()}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8")
  await rename(tempPath, schedulePath())
}

/**只挑今天还没跑的可用账号；禁用账号不参与自动化。 */
export function pickAccountsNeedingRun(
  entries: WorkbuddyPoolEntry[],
  state: DailyScheduleState,
  today = formatScheduleDay(new Date()),
) {
  return entries.filter((entry) => !entry.disabled && state.lastRunByUid[entry.uid] !== today)
}

export function summarizeDailyRun(result: DailyRunResult) {
  const errors = result.steps.filter((step) => step.status === "error")
  const parts = [
    result.creditTotal > 0 ? `入账 +${result.creditTotal}分` : "无新增积分",
    ...(result.streakDays ? [`连登 ${result.streakDays}天`] : []),
    ...(errors.length
      ? [`异常 ${errors.length}项：${errors.map((step) => `${step.label} ${step.message}`).join("；")}`]
      : []),
  ]
  const text = parts.join("；")
  return Array.from(text).slice(0, RESULT_PREVIEW_LIMIT).join("")
}

/**跑完就落日期（含异常步骤）；下一次 2 小时巡检自然跳过。 */
export async function recordDailyRun(uid: string, result: DailyRunResult) {
  const state = await readDailyScheduleState()
  state.lastRunByUid[uid] = formatScheduleDay(new Date())
  state.lastResultByUid = {
    ...(state.lastResultByUid ?? {}),
    [uid]: summarizeDailyRun(result),
  }
  await writeDailyScheduleState(state)
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function truncateResult(text: string) {
  return Array.from(text).slice(0, RESULT_PREVIEW_LIMIT).join("")
}

/**
 *启动检查一次，之后每 2 小时巡检一次所有账号。
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
    const today = formatScheduleDay(new Date())
    const state = await readDailyScheduleState()
    if (!pickAccountsNeedingRun([entry], state, today).length) continue
    if (!tryLockTaskAccount(entry.uid)) {
      result.locked.push(entry.uid)
      continue
    }

    if (!isFirstRun) await sleep(ACCOUNT_GAP_MS)
    isFirstRun = false
    try {
      let summary: string
      try {
        const account = await readPoolAccount(entry.uid)
        const dailyResult = await runDailyRewards(account)
        summary = summarizeDailyRun(dailyResult)
      } catch (error) {
        summary = truncateResult(`执行失败：${errorText(error)}`)
      }
      await recordDailyRunText(entry.uid, summary)
      result.ran.push({ uid: entry.uid, result: summary })
    } finally {
      unlockTaskAccount(entry.uid)
    }
  }
  return result
}

async function recordDailyRunText(uid: string, summary: string) {
  const state = await readDailyScheduleState()
  state.lastRunByUid[uid] = formatScheduleDay(new Date())
  state.lastResultByUid = {
    ...(state.lastResultByUid ?? {}),
    [uid]: summary,
  }
  await writeDailyScheduleState(state)
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
  } catch {
    //巡检失败不中断服务；下一轮 2 小时后再试。
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
