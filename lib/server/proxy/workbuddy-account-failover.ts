import "server-only"

import {
  freezeGlobalPoolAccount,
} from "@/lib/server/workbuddy/global-pool-store"
import {
  WorkbuddyRateLimitError,
} from "@/lib/server/workbuddy/rate-limit"
import {
  freezePoolAccount,
} from "@/lib/server/workbuddy/task-pool-store"
import {
  withWorkbuddyTargetCredentials,
} from "@/lib/server/workbuddy/upstream"
import type {
  EndpointFailoverResult,
} from "./endpoint-failover"
import { fetchWithEndpointFailover } from "./endpoint-failover"
import type { ProxyTarget } from "./common"

/**
 * WorkBuddy 账号层轮换：冻结刚返回精确限频的账号，用下一个可用账号重试。
 *
 * 这里位于端点切换之外。只有上游在首个有效输出前返回 WorkBuddy 专用限频时
 * 才会进入；普通配额错误、网络错误和已经输出后的失败都保持原行为。
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

  while (true) {
    try {
      return await fetchWithEndpointFailover({
        ...params,
        target,
      })
    } catch (error) {
      if (!(error instanceof WorkbuddyRateLimitError)) throw error
      const account = target.workbuddyAccount
      if (!account) throw error

      attemptedUids.add(account.uid)
      const nextUid =
        account.realm === "global"
          ? await freezeGlobalPoolAccount(account.uid, error.rateLimit)
          : await freezePoolAccount(account.uid, error.rateLimit)
      if (!nextUid || attemptedUids.has(nextUid)) throw error

      target = await withWorkbuddyTargetCredentials(target, nextUid)
      params.attemptedUids?.push(account.uid)
      delete target.attemptedEndpointIds
      delete target.failoverReason
    }
  }
}
