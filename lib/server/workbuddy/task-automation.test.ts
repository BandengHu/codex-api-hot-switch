import assert from "node:assert/strict"
import test from "node:test"

import { orderAutomationTaskCodes } from "./task-automation"

test("auto 任务排在批量接取与其余任务之前，并从后续队列移除", () => {
  const ordered = orderAutomationTaskCodes([
    { taskCode: "chat_5", taskType: "single" },
    { taskCode: "first_buddy", taskType: "auto" },
    { taskCode: "future_auto", taskType: " AUTO " },
  ])

  assert.deepEqual(ordered.autoCodes, ["first_buddy", "future_auto"])
  assert.equal(ordered.otherCodes.includes("first_buddy"), false)
  assert.equal(ordered.otherCodes.includes("future_auto"), false)
  assert.equal(ordered.otherCodes.includes("chat_5"), true)
})

test("没有 auto 任务时不改变静态动作表顺序", () => {
  const ordered = orderAutomationTaskCodes([
    { taskCode: "chat_5", taskType: "" },
    { taskCode: "first_buddy", taskType: "single" },
  ])

  assert.deepEqual(ordered.autoCodes, [])
  assert.equal(ordered.otherCodes[0], "chat_5")
})
