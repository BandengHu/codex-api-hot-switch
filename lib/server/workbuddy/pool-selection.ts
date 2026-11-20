import "server-only"

import type { WorkbuddyAccountBan } from "./account-ban"

export interface WorkbuddyAccountRateLimit {
  resetAt: string
  message: string
}

export interface WorkbuddySelectableEntry {
  uid: string
  disabled: boolean
  /** 是否参与聊天转发出站选号；undefined 视为启用。 */
  relayEnabled?: boolean
  /** 是否参与自动签到/每日任务；undefined 视为启用。 */
  automationEnabled?: boolean
}

export interface WorkbuddySelectableState {
  activeUid?: string
  entries: WorkbuddySelectableEntry[]
  rateLimits?: Record<string, WorkbuddyAccountRateLimit>
  accountBans?: Record<string, WorkbuddyAccountBan>
}

function isActiveRateLimit(
  rateLimit: WorkbuddyAccountRateLimit | undefined,
  now: number,
) {
  if (!rateLimit) return false
  const resetAt = Date.parse(rateLimit.resetAt)
  return Number.isFinite(resetAt) && resetAt > now
}

export function activeRateLimitOf(
  state: WorkbuddySelectableState,
  uid: string,
  now = Date.now(),
) {
  const rateLimit = state.rateLimits?.[uid]
  return isActiveRateLimit(rateLimit, now) ? rateLimit : undefined
}

export function accountBanOf(
  state: WorkbuddySelectableState,
  uid: string,
) {
  return state.accountBans?.[uid]
}

/**
 * 两个账号级开关的判定。
 *
 * `disabled` 仍是总开关：关掉就既不转发也不自动化。在这之上再拆两个
 * 独立维度，这样"只用它转发、不让它跑任务"或"只领积分、不占转发出口"
 * 都能表达。字段缺失一律视为启用，老数据无需迁移。
 */
export function relayAllowed(entry: WorkbuddySelectableEntry) {
  return !entry.disabled && entry.relayEnabled !== false
}

export function automationAllowed(entry: WorkbuddySelectableEntry) {
  return !entry.disabled && entry.automationEnabled !== false
}

/**
 * 按池顺序列出候选账号：显式选中的账号排最前，其余按 entries 顺序。
 *
 * 这里只做纯状态过滤（禁用/封禁/限频）；凭据过期需要读盘才知道，
 * 由调用方沿着这个顺序继续探测。
 */
export function selectableUidsOf(
  state: WorkbuddySelectableState,
  orderedEntries: WorkbuddySelectableEntry[],
  now = Date.now(),
) {
  const isSelectable = (uid: string) =>
    !accountBanOf(state, uid) && !activeRateLimitOf(state, uid, now)
  const uids = orderedEntries
    .filter((entry) => relayAllowed(entry) && isSelectable(entry.uid))
    .map((entry) => entry.uid)
  const activeUid = state.activeUid?.trim()
  if (!activeUid || !uids.includes(activeUid)) return uids
  return [activeUid, ...uids.filter((uid) => uid !== activeUid)]
}

/**
 * 当前账号不可用后，按池顺序列出「之后」的候选账号，末尾回绕。
 *
 * 回绕时会包含 afterUid 自己——全部其他账号都限频时，原账号仍是唯一可能可用的。
 */
export function selectableUidsAfter(
  state: WorkbuddySelectableState,
  orderedEntries: WorkbuddySelectableEntry[],
  afterUid: string,
  now = Date.now(),
) {
  const enabled = orderedEntries.filter(
    (entry) => relayAllowed(entry) && !accountBanOf(state, entry.uid),
  )
  const currentIndex = enabled.findIndex((entry) => entry.uid === afterUid)
  const start = currentIndex >= 0 ? currentIndex + 1 : 0
  const uids: string[] = []
  for (let offset = 0; offset < enabled.length; offset += 1) {
    const entry = enabled[(start + offset) % enabled.length]
    if (!activeRateLimitOf(state, entry.uid, now)) uids.push(entry.uid)
  }
  return uids
}

export function availableUidOf(
  state: WorkbuddySelectableState,
  orderedEntries: WorkbuddySelectableEntry[],
  now = Date.now(),
) {
  return selectableUidsOf(state, orderedEntries, now)[0]
}

export function nextAvailableUidOf(
  state: WorkbuddySelectableState,
  orderedEntries: WorkbuddySelectableEntry[],
  afterUid: string,
  now = Date.now(),
) {
  return selectableUidsAfter(state, orderedEntries, afterUid, now)[0]
}

export function preferredRateLimitOf(
  state: WorkbuddySelectableState,
  orderedEntries: WorkbuddySelectableEntry[],
  now = Date.now(),
) {
  const activeUid = state.activeUid?.trim()
  if (activeUid) {
    const active = activeRateLimitOf(state, activeUid, now)
    if (active) return active
  }
  for (const entry of orderedEntries) {
    const rateLimit = activeRateLimitOf(state, entry.uid, now)
    if (rateLimit) return rateLimit
  }
  return undefined
}

export function pruneExpiredRateLimits(
  state: WorkbuddySelectableState,
  now = Date.now(),
) {
  if (!state.rateLimits) return false
  let changed = false
  for (const [uid, rateLimit] of Object.entries(state.rateLimits)) {
    if (isActiveRateLimit(rateLimit, now)) continue
    delete state.rateLimits[uid]
    changed = true
  }
  return changed
}
