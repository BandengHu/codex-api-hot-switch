import assert from "node:assert/strict"
import test from "node:test"

import { formatIntegerCount } from "./display-format"

test("integer display rounds floating-point credit artifacts", () => {
  assert.equal(formatIntegerCount(2300.78), "2,301")
  assert.equal(formatIntegerCount(118.07999999999998), "118")
  assert.equal(formatIntegerCount(0.25), "0")
})
