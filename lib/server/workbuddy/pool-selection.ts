import "server-only"

export interface WorkbuddyAccountRateLimit {
  resetAt: string
  message: string
}

export interface WorkbuddySelectableEntry {
  uid: string
  disabled: boolean
}

export interface WorkbuddySelectableState {
  activeUid?: string
  entries: WorkbuddySelectableEntry[]
  rateLimits?: Record<string, WorkbuddyAccountRateLimit>
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

export function availableUidOf(
  state: WorkbuddySelectableState,
  orderedEntries: WorkbuddySelectableEntry[],
  now = Date.now(),
) {
  const activeUid = state.activeUid?.trim()
  if (
    activeUid &&
    orderedEntries.some(
      (entry) =>
        entry.uid === activeUid &&
        !entry.disabled &&
        !activeRateLimitOf(state, entry.uid, now),
    )
  ) {
    return activeUid
  }
  return orderedEntries.find(
    (entry) =>
      !entry.disabled && !activeRateLimitOf(state, entry.uid, now),
  )?.uid
}

export function selectedUidOf(
  state: WorkbuddySelectableState,
  orderedEntries: WorkbuddySelectableEntry[],
) {
  const activeUid = state.activeUid?.trim()
  if (
    activeUid &&
    orderedEntries.some(
      (entry) => entry.uid === activeUid && !entry.disabled,
    )
  ) {
    return activeUid
  }
  return orderedEntries.find((entry) => !entry.disabled)?.uid
}

export function nextAvailableUidOf(
  state: WorkbuddySelectableState,
  orderedEntries: WorkbuddySelectableEntry[],
  afterUid: string,
  now = Date.now(),
) {
  const enabled = orderedEntries.filter((entry) => !entry.disabled)
  const currentIndex = enabled.findIndex((entry) => entry.uid === afterUid)
  const start = currentIndex >= 0 ? currentIndex + 1 : 0
  for (let offset = 0; offset < enabled.length; offset += 1) {
    const entry = enabled[(start + offset) % enabled.length]
    if (!activeRateLimitOf(state, entry.uid, now)) return entry.uid
  }
  return undefined
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
