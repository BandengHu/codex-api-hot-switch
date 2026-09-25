import "server-only"

import { asNumber, realmBase, taskFetch } from "./api-client"
import type { WorkbuddyAccount } from "./account"
import { sleep } from "./task-query"

/**
 * 开学季分享任务（`share_invite`）。
 *
 * 端点与判据照搬 `workbuddy2api-panel`（GitHub开源项目）三账号实测结论：
 * 活动在期时，`POST {billing}/portal/activity/school/tasks/share-complete`
 * 即点亮，随后 claim 可得每日 +100 积分 +1 次抽奖。活动结束后 `in_period=false`。
 */

const SCHOOL_BASE = "/portal/activity/school"

export interface SchoolShareTaskState {
  taskCode: string
  status: string
  progress: number
  targetCount: number
}

export interface SchoolShareState {
  inPeriod: boolean
  shareTask?: SchoolShareTaskState
}

export function parseSchoolTask(entry: unknown): SchoolShareTaskState | undefined {
  if (!entry || typeof entry !== "object") return undefined
  const item = entry as Record<string, unknown>
  const taskCode = typeof item.task_code === "string" ? item.task_code.trim() : ""
  if (!taskCode) return undefined
  return {
    taskCode,
    status: typeof item.status === "string" ? item.status : "",
    progress: asNumber(item.progress) ?? 0,
    targetCount: asNumber(item.target_count) ?? 0,
  }
}

export function parseSchoolShareRecord(data: unknown): SchoolShareState {
  const record = (data ?? {}) as Record<string, unknown>
  const tasks = Array.isArray(record.tasks) ? record.tasks : []
  const shareTask = tasks
    .map(parseSchoolTask)
    .find((task): task is SchoolShareTaskState => task?.taskCode === "share_invite")
  return {
    inPeriod: record.in_period === true,
    ...(shareTask ? { shareTask } : {}),
  }
}

export async function fetchSchoolShareState(
  account: WorkbuddyAccount,
): Promise<SchoolShareState> {
  const base = realmBase(account)
  const record = await taskFetch(
    account,
    `${base.billing}${SCHOOL_BASE}/tasks`,
    { method: "GET" },
    "查询开学季分享任务",
  )
  return parseSchoolShareRecord(record.data)
}

export async function completeSchoolShare(account: WorkbuddyAccount) {
  const base = realmBase(account)
  await taskFetch(
    account,
    `${base.billing}${SCHOOL_BASE}/tasks/share-complete`,
    { method: "POST", body: { channel: "wechat" } },
    "上报开学季分享",
  )
}

export async function claimSchoolShare(account: WorkbuddyAccount) {
  const base = realmBase(account)
  const record = await taskFetch(
    account,
    `${base.billing}${SCHOOL_BASE}/tasks/share_invite/claim`,
    { method: "POST", body: {} },
    "领取开学季分享奖励",
  )
  const data = (record.data ?? {}) as Record<string, unknown>
  return {
    credit: asNumber(data.credit) ?? 0,
    chanceGranted: asNumber(data.chance_granted) ?? 0,
  }
}

/**share-complete 后异步计分；按参考项目口径短轮询，最多约 7.5 秒。 */
export async function pollSchoolShareProgress(
  account: WorkbuddyAccount,
  attempts = 3,
): Promise<SchoolShareTaskState | undefined> {
  for (let index = 0; index < attempts; index++) {
    await sleep(2_500)
    const state = await fetchSchoolShareState(account).catch(() => undefined)
    if (state?.shareTask) {
      const task = state.shareTask
      if (task.status === "completed" || task.status === "claimed" || (task.targetCount > 0 && task.progress >= task.targetCount)) {
        return task
      }
    }
  }
  const state = await fetchSchoolShareState(account).catch(() => undefined)
  return state?.shareTask
}
