import "server-only"

import type { WorkbuddyAccount } from "./account"
import { uniqueId } from "./api-client"
import { reportChatActivity } from "./report"
import { isGlobalAccount } from "./task-api"
import { acceptTask, claimTaskFor, findTask, sleep } from "./task-query"
import { isNightWindow, workbuddyNightKey } from "./workbuddy-time"

export interface NightOwlResult {
  key: string
  windowOpen: boolean
  status: "done" | "skipped" | "error"
  message: string
  credit?: number
}

export interface NightOwlTaskState {
  accepted: boolean
  claimed: boolean
  current: number
  target: number
  claimable: boolean
}

export function nightOwlNeedsReport(task: NightOwlTaskState) {
  return !task.claimed && !task.claimable && task.current < task.target
}

/**
 * 夜猫子任务（black_cat）。
 *
 * 官方口径是每晚 23:00-08:00 只计一次，累计三天。这里只上报
 * `chat_request_send` 的 night 事件，不额外发起真实对话；先 accept，
 * 再回读任务进度，达标后领奖。
 */
export async function runNightOwl(
  account: WorkbuddyAccount,
  now = new Date(),
): Promise<NightOwlResult> {
  const key = workbuddyNightKey(now)
  if (isGlobalAccount(account)) {
    return {
      key,
      windowOpen: false,
      status: "skipped",
      message: "国际站账号没有国内成长任务",
    }
  }
  if (!isNightWindow(now)) {
    return {
      key,
      windowOpen: false,
      status: "skipped",
      message: "当前不在 23:00-08:00 夜间窗口",
    }
  }

  let task = await findTask(account, "black_cat")
  if (!task) {
    return { key, windowOpen: true, status: "skipped", message: "未下发夜猫子任务" }
  }
  if (task.claimed) {
    return { key, windowOpen: true, status: "skipped", message: "夜猫子任务已领奖" }
  }

  if (task.acceptStatus === "not_accepted" || task.acceptStatus === "") {
    if (!(await acceptTask(account, "black_cat"))) {
      throw new Error("夜猫子任务接取失败")
    }
    task = (await findTask(account, "black_cat")) ?? task
  }

  let target = task.target > 0 ? task.target : 3
  if (task.current >= target) {
    const claim = await claimTaskFor(account, "black_cat")
    return {
      key,
      windowOpen: true,
      status: "done",
      message: `夜猫子任务已达标，领取 +${claim.credit} 分`,
      credit: claim.credit,
    }
  }

  const conversationId = uniqueId("wb-night")
  await reportChatActivity(
    account,
    conversationId,
    `${conversationId}-req`,
    "glm-5.2",
    "GLM-5.2",
    "night",
  )
  let fresh: Awaited<ReturnType<typeof findTask>>
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(attempt === 0 ? 1_500 : 3_000)
    const latest = await findTask(account, "black_cat")
    fresh = latest
    if (
      latest &&
      (latest.claimed || latest.claimable || latest.current > task.current)
    ) {
      fresh = latest
      break
    }
  }
  if (!fresh) {
    return {
      key,
      windowOpen: true,
      status: "done",
      message: "夜间事件已上报，但任务状态暂未回读",
    }
  }
  target = fresh.target > 0 ? fresh.target : target
  if (fresh.current >= target || fresh.claimable) {
    const claim = await claimTaskFor(account, "black_cat")
    return {
      key,
      windowOpen: true,
      status: "done",
      message: `夜猫子任务完成 ${fresh.current}/${target}，领取 +${claim.credit} 分`,
      credit: claim.credit,
    }
  }
  return {
    key,
    windowOpen: true,
    status: "done",
    message: `今晚已计 1 次（${fresh.current}/${target}），明晚继续`,
  }
}
