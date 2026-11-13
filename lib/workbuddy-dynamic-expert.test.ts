import assert from "node:assert/strict"
import test from "node:test"

import {
  isWorkbuddyDynamicExpertId,
  resolveWorkbuddyDynamicExpertTask,
} from "./workbuddy-dynamic-expert"

test("动态专家任务支持嵌套 deeplink 和直接 expertId", () => {
  assert.deepEqual(
    resolveWorkbuddyDynamicExpertTask({
      taskCode: "expert_use_new",
      title: "新专家体验",
      jumpUrl:
        "workbuddy://open?deeplink=" +
        encodeURIComponent("workbuddy://chat?expertId=ex_New123&source=task"),
    }),
    { expertId: "ex_New123", expertName: "新专家体验" },
  )
  assert.deepEqual(
    resolveWorkbuddyDynamicExpertTask({
      taskCode: "temporary_expert",
      title: "临时专家",
      jumpUrl: "workbuddy://chat?expertId=WorkspaceBuilder",
    }),
    { expertId: "WorkspaceBuilder", expertName: "临时专家" },
  )
})

test("动态专家解析忽略固定任务、普通链接和非法 ID", () => {
  assert.equal(
    resolveWorkbuddyDynamicExpertTask({
      taskCode: "workstation_expert",
      title: "固定专家",
      jumpUrl: "workbuddy://chat?expertId=ex_Other",
    }),
    undefined,
  )
  assert.equal(
    resolveWorkbuddyDynamicExpertTask({
      taskCode: "campaign",
      title: "运营活动",
      jumpUrl: "workbuddy://campaign?id=1",
    }),
    undefined,
  )
  assert.equal(
    resolveWorkbuddyDynamicExpertTask({
      taskCode: "bad_expert",
      title: "非法专家",
      jumpUrl: "workbuddy://chat?expertId=javascript%3Aalert(1)",
    }),
    undefined,
  )
  assert.equal(isWorkbuddyDynamicExpertId("ex_Valid_123"), true)
  assert.equal(isWorkbuddyDynamicExpertId("ex_../bad"), false)
})
