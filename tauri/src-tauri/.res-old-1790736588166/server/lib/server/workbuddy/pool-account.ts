import "server-only"

import type { WorkbuddyAccount } from "./account"
import { readActiveUid, readPoolAccount } from "./task-pool-store"

/**
 * 「当前生效账号」的读取入口。
 *
 * 代理转发、模型发现、连通性测试都从这里取登录态：号池里被手动选中的账号优先，
 * 没选过就回落本机桌面端登录态（`local`）。
 *
 * **不做自动轮转**：切号只由用户在号池界面点「切换/设为转发账号」触发，
 * 即 `setActivePoolAccount`。转发链路只读不写，失败就把错误原样抛出，让上层看到
 * 真实原因（例如选中的账号凭据已过期），而不是悄悄换一个号。
 */
export async function readActivePoolAccount(): Promise<WorkbuddyAccount> {
 const uid = await readActiveUid()
 return readPoolAccount(uid)
}

/**当前生效账号的 uid（`local` = 本机桌面端登录态）。 */
export async function activePoolUid() {
 return readActiveUid()
}
