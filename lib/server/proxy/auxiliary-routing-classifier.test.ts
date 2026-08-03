import assert from "node:assert/strict"
import test from "node:test"

import { isMemoryMaintenanceRequest } from "./auxiliary-routing-classifier"

test("explicit memory writing requests use auxiliary routing", () => {
  assert.equal(
    isMemoryMaintenanceRequest({
      input: [{ role: "developer", content: "You are a Memory Writing Agent." }],
    }),
    true,
  )
  assert.equal(
    isMemoryMaintenanceRequest({
      input: [{ role: "developer", content: "Phase 2 (Consolidation)" }],
    }),
    true,
  )
})

test("ordinary Codex memory guidance does not use auxiliary routing", () => {
  assert.equal(
    isMemoryMaintenanceRequest({
      input: [
        {
          role: "developer",
          content:
            "Memory files are stored under C:\\Users\\Administrator\\.codex\\memories.",
        },
        {
          role: "user",
          content: "检查这个项目的执行器稳定性",
        },
      ],
    }),
    false,
  )
})

test("unrelated consolidation text does not use auxiliary routing", () => {
  assert.equal(
    isMemoryMaintenanceRequest({
      input: [{ role: "user", content: "Consolidation of provider routes" }],
    }),
    false,
  )
})
