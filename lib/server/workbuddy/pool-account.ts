import "server-only"

import type { WorkbuddyAccount } from "./account"
import { readActivePoolAccount as readActivePoolAccountFromStore } from "./task-pool-store"

/**
 * 「当前生效账号」的读取入口。
 *
 * 代理转发、模型发现、连通性测试都从这里取登录态：号池里被手动选中的账号优先，
 * 没选过就回落本机桌面端登录态（`local`）。
 *
 * 上游返回 WorkBuddy 专用限频时，转发链路会冻结对应账号并切到下一个可用账号；
 * 号池全部不可用时把原始限频错误抛给上层。其他失败仍直接抛出真实原因。
 *
 * 登录态已过期的账号会被跳过，不会成为转发出口。
 */
export async function readActivePoolAccount(): Promise<WorkbuddyAccount> {
  return (await readActivePoolAccountFromStore()).account
}

/**当前生效账号的 uid（`local` = 本机桌面端登录态）。 */
export async function activePoolUid() {
  return (await readActivePoolAccountFromStore()).uid
}
