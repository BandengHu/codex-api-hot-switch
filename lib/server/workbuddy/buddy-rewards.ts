import "server-only"

import type { WorkbuddyAccount } from "./account"
import { asNumber, realmBase, taskFetch } from "./api-client"

export interface BuddyQuota {
  affordable: number
  maxOpenCount: number
}

export interface BuddyOpenResult {
  count: number
  names: string[]
}

function textValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()]
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
}

export function parseBuddyQuota(data: unknown): BuddyQuota {
  const record = (data ?? {}) as Record<string, unknown>
  return {
    affordable: Math.max(0, asNumber(record.affordable) ?? 0),
    maxOpenCount: Math.max(1, asNumber(record.max_open_count) ?? 1),
  }
}

export function buddyOpenCount(quota: BuddyQuota) {
  return Math.min(
    Math.max(0, Math.floor(quota.affordable)),
    Math.max(1, Math.floor(quota.maxOpenCount)),
  )
}

/** 读取成长能量可开启的 Buddy 盲盒数量。 */
export async function fetchBuddyQuota(account: WorkbuddyAccount): Promise<BuddyQuota> {
  const base = realmBase(account)
  const record = await taskFetch(
    account,
    `${base.chat}/v2/activity/growth/buddy/quota`,
    { method: "GET", fingerprint: "desktop", retry: true },
    "查询 Buddy 盲盒额度",
  )
  return parseBuddyQuota(record.data)
}

/**
 * 消耗成长能量开启盲盒。
 *
 * 盲盒只产出 Buddy，不直接增加积分；返回 undefined 表示当前能量不足，
 * 调用方必须保持“未开启”而不是把它算成失败。
 */
export async function openBuddyBoxes(
  account: WorkbuddyAccount,
): Promise<BuddyOpenResult | undefined> {
  const quota = await fetchBuddyQuota(account)
  const count = buddyOpenCount(quota)
  if (count <= 0) return undefined

  const base = realmBase(account)
  const record = await taskFetch(
    account,
    `${base.chat}/v2/activity/growth/buddy/open`,
    {
      method: "POST",
      fingerprint: "desktop",
      body: {
        count,
        client_token: crypto.randomUUID(),
      },
    },
    "开启 Buddy 盲盒",
  )
  const data = (record.data ?? {}) as Record<string, unknown>
  const names = [
    ...textValues(data.buddy),
    ...textValues(data.name),
    ...textValues(data.buddies),
  ]
  return { count, names }
}
