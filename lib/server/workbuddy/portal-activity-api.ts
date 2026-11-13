import "server-only"

import type { WorkbuddyAccount } from "./account"
import { asNumber, realmBase, taskFetch, type TaskFetchInit } from "./api-client"

const MP_PAGE_HEADERS = {
  "x-client-product": "workbuddy-mp",
  "x-client-version": "2.4.0",
  "x-client-platform": "mp-weixin",
  "x-platform": "wechatmp",
  "content-type": "application/json",
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 14; MicroMessenger/8.0.49 WeChat/0.8.0 MiniProgramEnv/android; wkbrowser xweb)",
} as const

export interface PortalActivityTask {
  taskCode: string
  target: number
  progress: number
  completedAt?: string
  claimedAt?: string
  needView: boolean
  credit: number
}

function encoded(value: string) {
  return encodeURIComponent(value)
}

function activityCall(
  account: WorkbuddyAccount,
  path: string,
  init: Pick<TaskFetchInit, "method" | "body">,
  context: string,
) {
  const base = realmBase(account)
  return taskFetch(
    account,
    `${base.billing}${path}`,
    {
      ...init,
      headers: MP_PAGE_HEADERS,
      retry: init.method === "GET",
    },
    context,
  )
}

/**
 * 运营活动任务使用独立的 portal 契约，不属于成长任务列表。
 * 读取失败必须抛错，不能伪装成“活动未下发”。
 */
export async function fetchPortalActivityTasks(
  account: WorkbuddyAccount,
  activityCode: string,
): Promise<Map<string, PortalActivityTask>> {
  const record = await activityCall(
    account,
    `/portal/activity/tasks?activity_code=${encoded(activityCode)}`,
    { method: "GET" },
    "读取运营活动任务",
  )
  const data = (record.data ?? {}) as Record<string, unknown>
  const progressRows = Array.isArray(data.progress) ? data.progress : []
  const progressByCode = new Map<string, Record<string, unknown>>()
  for (const value of progressRows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    const taskCode = typeof row.task_code === "string" ? row.task_code : ""
    if (taskCode) progressByCode.set(taskCode, row)
  }

  const result = new Map<string, PortalActivityTask>()
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  for (const value of tasks) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const task = value as Record<string, unknown>
    const taskCode = typeof task.task_code === "string" ? task.task_code : ""
    if (!taskCode) continue
    const progress = progressByCode.get(taskCode) ?? {}
    const completedAt = typeof progress.completed_at === "string" ? progress.completed_at : undefined
    const claimedAt = typeof progress.claimed_at === "string" ? progress.claimed_at : undefined
    result.set(taskCode, {
      taskCode,
      target: asNumber(task.target_count) ?? 0,
      progress: asNumber(progress.progress) ?? 0,
      ...(completedAt ? { completedAt } : {}),
      ...(claimedAt ? { claimedAt } : {}),
      needView: task.need_view !== false,
      credit: asNumber(task.reward_credit) ?? 0,
    })
  }
  return result
}

export async function markPortalActivityTaskViewed(
  account: WorkbuddyAccount,
  activityCode: string,
  taskCode: string,
) {
  await activityCall(
    account,
    `/portal/activity/tasks/${encoded(taskCode)}/viewed?activity_code=${encoded(activityCode)}`,
    { method: "POST", body: {} },
    "标记运营活动任务已查看",
  )
}

/** claim 的 POST 成功不代表到账；返回后仍须回读 claimed_at。 */
export async function claimPortalActivityTask(
  account: WorkbuddyAccount,
  activityCode: string,
  taskCode: string,
) {
  await activityCall(
    account,
    `/portal/activity/tasks/${encoded(taskCode)}/claim?activity_code=${encoded(activityCode)}`,
    { method: "POST", body: {} },
    "领取运营活动奖励",
  )
}

export async function pollPortalActivityTask(
  account: WorkbuddyAccount,
  activityCode: string,
  taskCode: string,
  predicate: (task: PortalActivityTask) => boolean,
  attempts: number,
  gapMs: number,
) {
  let latest: PortalActivityTask | undefined
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, gapMs))
    const rows = await fetchPortalActivityTasks(account, activityCode)
    latest = rows.get(taskCode)
    if (!latest) continue
    if (predicate(latest)) return latest
  }
  return latest
}
