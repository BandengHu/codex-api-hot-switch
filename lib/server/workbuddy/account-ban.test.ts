import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import {
  isWorkbuddyAccountBanPayload,
  workbuddyAccountBanFromText,
} from "./account-ban"

const MESSAGE = "账号存在异常行为，已被限制使用"

test("11140 is detected in a nested envelope even when an outer code is zero", () => {
  const payload = {
    code: 0,
    data: {
      response: {
        error_code: "11140",
        message: MESSAGE,
      },
    },
  }
  assert.equal(isWorkbuddyAccountBanPayload(403, payload), true)
})

test("only HTTP 403 is treated as an account ban", () => {
  const payload = { code: 11140, message: MESSAGE }
  assert.equal(isWorkbuddyAccountBanPayload(400, payload), false)
  assert.equal(isWorkbuddyAccountBanPayload(403, { code: 11129 }), false)
})

test("plain text carrying 11140 is detected as an account ban", () => {
  const error = workbuddyAccountBanFromText(
    403,
    `Illegal API invocation: {"code":11140,"message":"${MESSAGE}"}`,
  )
  assert.ok(error)
  assert.equal(error.status, 403)
  assert.equal(error.kind, "auth")
  assert.equal(error.ban.code, 11140)
  assert.equal(error.message, MESSAGE)
})
