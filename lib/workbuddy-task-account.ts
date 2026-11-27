import type { WorkbuddyPoolEntryView } from "./workbuddy-pool-types"

/**
 * 任务操作只排除账号级不可用状态。
 *
 * 限频冻结的是聊天转发出口，签到、成长任务和领奖仍可独立执行；登录态失效
 * 则意味着任务接口本身拿不到授权，必须先重新授权登录。
 */
export function isWorkbuddyTaskAccount(entry: WorkbuddyPoolEntryView) {
  return !entry.disabled && !entry.accountBan && !entry.credentialFailure
}
