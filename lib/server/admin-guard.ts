import "server-only"

import type { AccountRecord } from "./accounts-store"
import {
  accessAuthRequired,
  accountFromRequest,
  withAccountContext,
} from "./access-guard"

/**
 * 管理员专用接口的守卫。
 *
 * 本机模式没有账号体系，视为拥有全部权限（与改造前一致）；
 * 服务器模式下必须是 role=admin 且状态为 active 的账号。
 */
export function isAdminAccount(account: AccountRecord | null | undefined) {
  return account?.role === "admin" && account.status === "active"
}

export async function runAdmin<T>(
  request: Request,
  handler: (account: AccountRecord | null) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; status: number; message: string }> {
  if (!accessAuthRequired()) {
    return { ok: true, value: await handler(null) }
  }
  const context = await accountFromRequest(request)
  if (!context) {
    return { ok: false, status: 401, message: "需要先登录" }
  }
  if (!isAdminAccount(context.account)) {
    return { ok: false, status: 403, message: "需要管理员权限" }
  }
  return {
    ok: true,
    value: await withAccountContext(context, () => handler(context.account)),
  }
}
