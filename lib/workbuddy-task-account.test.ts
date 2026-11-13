import assert from "node:assert/strict"
import test from "node:test"

import { isWorkbuddyTaskAccount } from "./workbuddy-task-account"
import type { WorkbuddyPoolEntryView } from "./workbuddy-pool-types"

function entry(
  overrides: Partial<WorkbuddyPoolEntryView> = {},
): WorkbuddyPoolEntryView {
  return {
    uid: "account-a",
    nickname: "",
    source: "file",
    disabled: false,
    ...overrides,
  }
}

test("限频账号仍可执行任务和领奖", () => {
  assert.equal(
    isWorkbuddyTaskAccount(
      entry({
        rateLimit: {
          message: "limited",
          resetAt: "2026-11-13T13:03:32.000Z",
        },
      }),
    ),
    true,
  )
})

test("禁用或封禁账号不能执行任务", () => {
  assert.equal(isWorkbuddyTaskAccount(entry({ disabled: true })), false)
  assert.equal(
    isWorkbuddyTaskAccount(
      entry({
        accountBan: {
          code: 11140,
          message: "Illegal API invocation from an unapproved channel",
          detectedAt: "2026-11-13T08:00:00.000Z",
        },
      }),
    ),
    false,
  )
})
