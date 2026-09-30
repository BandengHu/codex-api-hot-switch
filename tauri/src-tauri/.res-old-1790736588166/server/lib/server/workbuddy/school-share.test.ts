import "server-only"

import assert from "node:assert/strict"
import test from "node:test"

import { parseSchoolShareRecord } from "./school-share"

test("school-share:任务状态只暴露 share_invite", () => {
  const state = parseSchoolShareRecord({
    in_period: true,
    tasks: [
      { task_code: "other", status: "pending", progress: 1, target_count: 2 },
      { task_code: "share_invite", status: "completed", progress: 1, target_count: 1 },
    ],
  })
  assert.equal(state.inPeriod, true)
  assert.deepEqual(state.shareTask, {
    taskCode: "share_invite",
    status: "completed",
    progress: 1,
    targetCount: 1,
  })
})

test("school-share:坏数据按不在期处理", () => {
  assert.deepEqual(parseSchoolShareRecord(null), { inPeriod: false })
})
