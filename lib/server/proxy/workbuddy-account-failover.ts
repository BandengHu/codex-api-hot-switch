import "server-only"

import {
  accountBanOf,
  activeRateLimitOf,
} from "@/lib/server/workbuddy/pool-selection"
import {
  banGlobalPoolAccount,
  freezeGlobalPoolAccount,
  nextReadableGlobalUidAfter,
  readGlobalPoolState,
} from "@/lib/server/workbuddy/global-pool-store"
import {
  WorkbuddyAccountBanError,
} from "@/lib/server/workbuddy/account-ban"
import {
  WorkbuddyRateLimitError,
} from "@/lib/server/workbuddy/rate-limit"
import {
  banPoolAccount,
  freezePoolAccount,
  nextReadablePoolUidAfter,
  readPoolState,
} from "@/lib/server/workbuddy/task-pool-store"
import {
  withWorkbuddyTargetCredentials,
} from "@/lib/server/workbuddy/upstream"
import type {
  EndpointFailoverResult,
} from "./endpoint-failover"
import { fetchWithEndpointFailover } from "./endpoint-failover"
import type { ProxyTarget } from "./common"

async function assertWorkbuddyAccountAvailable(
  target: ProxyTarget,
  attemptedUids: ReadonlySet<string>,
) {
  const account = target.workbuddyAccount
  if (!account || attemptedUids.has(account.uid)) return
  const state =
    account.realm === "global"
      ? await readGlobalPoolState()
      : await readPoolState()
  const ban = accountBanOf(state, account.uid)
  if (ban) {
    throw new WorkbuddyAccountBanError(
      { code: ban.code, message: ban.message },
      new Date(ban.detectedAt),
    )
  }
  const rateLimit = activeRateLimitOf(state, account.uid)
  if (rateLimit) {
    throw new WorkbuddyRateLimitError(rateLimit)
  }
}

/**
 * WorkBuddy 账号层轮换：账号不可用时换下一个账号重试。
 *
 * 两种进入方式：
 * - 登录态已过期：说明这个号此刻根本发不出请求，直接换下一个未过期账号；
 * - 上游在首个有效输出前返回精确限频：冻结该账号再换下一个。
 *
 * 这里位于端点切换之外。普通配额错误、网络错误、凭据损坏和已经输出后的失败
 * 都保持原行为，不在这里重试。
 */
export async function fetchWithWorkbuddyAccountFailover(params: {
  target: ProxyTarget
  path: string
  body: unknown
  requestSignal?: AbortSignal
  requestIsStream: boolean
  capacityRetryEnabled: boolean
  attemptedUids?: string[]
}): Promise<EndpointFailoverResult> {
  let target = params.target
  const attemptedUids = new Set(params.attemptedUids ?? [])
  await assertWorkbuddyAccountAvailable(target, attemptedUids)

  /** 换到 nextUid：重新注入登录态，并清掉不再适用的端点失败记录。 */
  const switchTo = async (fromUid: string, nextUid: string) => {
    attemptedUids.add(fromUid)
    params.attemptedUids?.push(fromUid)
    const rotated = await withWorkbuddyTargetCredentials(target, nextUid)
    delete rotated.attemptedEndpointIds
    delete rotated.failoverReason
    return rotated
  }
  while (true) {
    try {
      return await fetchWithEndpointFailover({
        ...params,
        target,
      })
    } catch (error) {
      if (error instanceof WorkbuddyAccountBanError) {
        const account = target.workbuddyAccount
        if (account) {
          if (account.realm === "global") {
            await banGlobalPoolAccount(account.uid, error.ban)
          } else {
            await banPoolAccount(account.uid, error.ban)
          }
        }
        throw error
      }
      const account = target.workbuddyAccount
      if (!account) throw error

      if (!(error instanceof WorkbuddyRateLimitError)) throw error

      // freeze* 在冻结的同时会挑下一个**能读出来**的账号，过期号不会被选中。
      attemptedUids.add(account.uid)
      const nextUid =
        account.realm === "global"
          ? await freezeGlobalPoolAccount(account.uid, error.rateLimit)
          : await freezePoolAccount(account.uid, error.rateLimit)
      if (!nextUid || attemptedUids.has(nextUid)) throw error
      target = await switchTo(account.uid, nextUid)
      await assertWorkbuddyAccountAvailable(target, attemptedUids)
    }
  }
}
