import assert from "node:assert/strict"
import test from "node:test"

import {
  FIXED_EXPERT_TASKS,
} from "./actions-experts"
import {
  parseSkillShareChannel,
  preferredMarketSkill,
  skillShareEvents,
} from "./skill-share"
import {
  parseTemplateScenes,
  templateSceneEvents,
} from "./template-tasks"

test("技能分享必须同时带 share_code 和 link", () => {
  assert.throws(
    () =>
      parseSkillShareChannel({
        share_code: "share-1",
        ways: [{ share_way: "link", resource_ref: "" }],
      }),
    /share_code 或 link/,
  )
  assert.deepEqual(
    parseSkillShareChannel({
      share_code: "share-1",
      ways: [
        { share_way: "wxacode", resource_ref: "qr" },
        { share_way: "link", resource_ref: "https://example.test/share" },
      ],
    }),
    {
      shareCode: "share-1",
      resourceRef: "https://example.test/share",
    },
  )
})

test("技能分享优先使用已验证技能并生成 click/success 两条事件", () => {
  const skill = preferredMarketSkill([
    { id: "skill-other", name: "其他技能", description: "" },
    {
      id: "skill_2097350077599879168",
      name: "测试技能",
      description: "",
    },
  ])
  assert.ok(skill)
  const events = skillShareEvents(skill, "share-1", 123)
  assert.deepEqual(
    events.map((event) => event.panelAction),
    ["click", "success"],
  )
  assert.ok(
    events.every(
      (event) =>
        event.eventCode === "skill_share_channel_action" &&
        event.id === "share-1" &&
        event.actionAt === 123,
    ),
  )
})

test("模板场景读取服务端 id，并生成四事件组", () => {
  const scenes = parseTemplateScenes({
    scenes: [
      { id: 42, name: "场景 A" },
      { id: "43", name: "场景 B" },
    ],
  })
  assert.deepEqual(scenes, [
    { id: "42", name: "场景 A" },
    { id: "43", name: "场景 B" },
  ])
  const events = templateSceneEvents(scenes[0], {
    conversationId: "conversation",
    requestId: "request",
  })
  assert.deepEqual(
    events.map((event) => event.eventCode),
    [
      "agent_task_created",
      "agent_task_created_with_template",
      "template_used",
      "playbook_prompt_send",
    ],
  )
  assert.ok(events.every((event) => event.conversationId === "conversation"))
  assert.equal(events[0].template_id, "42")
})

test("固定专家任务保留上游要求的专家 id", () => {
  assert.deepEqual(
    FIXED_EXPERT_TASKS.map(({ taskCode, expertId }) => ({
      taskCode,
      expertId,
    })),
    [
      { taskCode: "WorkBuddy_Valorant", expertId: "ex_xQHHD1u5Jkua" },
      { taskCode: "workstation_expert", expertId: "WorkspaceBuilder" },
      { taskCode: "expert_use_maidehao", expertId: "ex_GDl31WahyIH0" },
      { taskCode: "expert_use_douyinyin", expertId: "ex_FbY5nlWTqDod" },
      {
        taskCode: "expert_use_shangjia_xuanchuan",
        expertId: "ex_Weo3x2EZuSDm",
      },
      { taskCode: "expert_use_bowangwang", expertId: "ex_WZY136wV5aMt" },
    ],
  )
})
