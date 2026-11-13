import type { WorkbuddyPoolEntryView } from "./workbuddy-pool-types"

/**
 * 任务操作只看账号是否被禁用或封禁。
 *
 * 限频冻结的是聊天转发出口，签到、成长任务和领奖仍可独立执行。
 */
export function isWorkbuddyTaskAccount(entry: WorkbuddyPoolEntryView) {
  return !entry.disabled && !entry.accountBan
}
