import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import {
  availableUidOf,
  automationAllowed,
  nextAvailableUidOf,
  preferredRateLimitOf,
  pruneExpiredRateLimits,
  relayAllowed,
  selectableUidsAfter,
  selectableUidsOf,
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
const QUOTA_EXHAUSTED = {
  message: "quota exhausted",
  kind: "quota_exhausted" as const,
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

test("relay 开关只影响转发，不影响自动化", () => {
  // 缺省：两个都启用
  const plain = { uid: "x", disabled: false }
  assert.equal(relayAllowed(plain), true)
  assert.equal(automationAllowed(plain), true)

  // 只领积分、不占转发出口
  const creditOnly = { uid: "x", disabled: false, relayEnabled: false }
  assert.equal(relayAllowed(creditOnly), false)
  assert.equal(automationAllowed(creditOnly), true)

  // 只转发、不自动签到
  const relayOnly = { uid: "x", disabled: false, automationEnabled: false }
  assert.equal(relayAllowed(relayOnly), true)
  assert.equal(automationAllowed(relayOnly), false)

  // 总开关仍然压过两者
  const off = { uid: "x", disabled: true }
  assert.equal(relayAllowed(off), false)
  assert.equal(automationAllowed(off), false)
})

test("关掉 relay 的账号不会被选为转发出口", () => {
  const value = {
    entries: [
      { uid: "credit-only", disabled: false, relayEnabled: false },
      { uid: "b", disabled: false },
    ],
  } satisfies WorkbuddySelectableState
  assert.equal(availableUidOf(value, value.entries, NOW), "b")
  assert.deepEqual(
    selectableUidsOf(value, value.entries, NOW),
    ["b"],
  )
  // 关掉转发不影响自动化：它照样该被每日调度挑中。
  assert.equal(automationAllowed(value.entries[0]), true)
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

test("quota exhaustion without a reset time never expires and is never pruned", () => {
  const value = state("a", { a: QUOTA_EXHAUSTED })
  assert.equal(availableUidOf(value, value.entries, NOW), "b")
  assert.equal(preferredRateLimitOf(value, value.entries, NOW), QUOTA_EXHAUSTED)
  assert.equal(pruneExpiredRateLimits(value, NOW), false)
  assert.deepEqual(value.rateLimits, { a: QUOTA_EXHAUSTED })
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

test("selectable order keeps the explicit active account first", () => {
  const value = state("c")
  assert.deepEqual(selectableUidsOf(value, value.entries, NOW), [
    "c",
    "a",
    "b",
  ])
})

test("selectable order drops disabled, banned and limited accounts", () => {
  const value = {
    ...state("a", { a: ACTIVE_LIMIT }),
    accountBans: {
      b: {
        code: 11140,
        message: "账号存在异常行为，已被限制使用",
        detectedAt: "2026-10-29T07:00:00.000Z",
      },
    },
  } satisfies WorkbuddySelectableState
  assert.deepEqual(selectableUidsOf(value, value.entries, NOW), ["c"])
  assert.deepEqual(selectableUidsAfter(value, value.entries, "c", NOW), ["c"])
})

test("selectable order after an account wraps around the pool", () => {
  const value = state(undefined)
  assert.deepEqual(selectableUidsAfter(value, value.entries, "c", NOW), [
    "a",
    "b",
    "c",
  ])
})
