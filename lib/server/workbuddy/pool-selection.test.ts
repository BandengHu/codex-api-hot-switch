import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import {
  availableUidOf,
  nextAvailableUidOf,
  preferredRateLimitOf,
  pruneExpiredRateLimits,
  type WorkbuddySelectableState,
} from "./pool-selection"

const NOW = Date.parse("2026-10-29T08:00:00.000Z")
const ACTIVE_LIMIT = {
  message: "limited",
  resetAt: "2026-10-29T09:00:00.000Z",
}
const EXPIRED_LIMIT = {
  message: "expired",
  resetAt: "2026-10-29T07:00:00.000Z",
}

function state(
  activeUid: string | undefined,
  rateLimits: WorkbuddySelectableState["rateLimits"] = {},
) {
  return {
    ...(activeUid ? { activeUid } : {}),
    entries: [
      { uid: "a", disabled: false },
      { uid: "b", disabled: false },
      { uid: "c", disabled: false },
      { uid: "disabled", disabled: true },
    ],
    rateLimits,
  } satisfies WorkbuddySelectableState
}

test("selection skips disabled and actively limited accounts", () => {
  const value = state("a", { a: ACTIVE_LIMIT })
  assert.equal(availableUidOf(value, value.entries, NOW), "b")
  assert.equal(nextAvailableUidOf(value, value.entries, "b", NOW), "c")
})

test("selection preserves the explicit active account while it remains available", () => {
  const value = state("c")
  assert.equal(availableUidOf(value, value.entries, NOW), "c")
})

test("expired limits stop blocking selection and are pruned", () => {
  const value = state("a", { a: EXPIRED_LIMIT })
  assert.equal(availableUidOf(value, value.entries, NOW), "a")
  assert.equal(preferredRateLimitOf(value, value.entries, NOW), undefined)
  assert.equal(pruneExpiredRateLimits(value, NOW), true)
  assert.deepEqual(value.rateLimits, {})
})

test("all actively limited accounts produce no next account", () => {
  const value = state("a", {
    a: ACTIVE_LIMIT,
    b: ACTIVE_LIMIT,
    c: ACTIVE_LIMIT,
  })
  assert.equal(availableUidOf(value, value.entries, NOW), undefined)
  assert.equal(nextAvailableUidOf(value, value.entries, "a", NOW), undefined)
  assert.equal(preferredRateLimitOf(value, value.entries, NOW), ACTIVE_LIMIT)
})

test("selection skips persistently banned accounts and never expires the ban", () => {
  const value = {
    ...state("a"),
    accountBans: {
      a: {
        code: 11140,
        message: "账号存在异常行为，已被限制使用",
        detectedAt: "2026-10-29T07:00:00.000Z",
      },
    },
  } satisfies WorkbuddySelectableState
  assert.equal(availableUidOf(value, value.entries, NOW), "b")
  assert.equal(nextAvailableUidOf(value, value.entries, "a", NOW), "b")
  assert.equal(nextAvailableUidOf(value, value.entries, "c", NOW), "b")
})
