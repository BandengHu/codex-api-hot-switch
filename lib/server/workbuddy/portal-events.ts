import "server-only"

import type { WorkbuddyAccount } from "./account"
import { realmBase, taskFetch, uniqueId } from "./api-client"
import type { UpstreamEvent } from "./report"

export interface PortalPageContext {
  pageURL: string
  pageName: string
}

function newId() {
  return crypto.randomUUID()
}

function requestId() {
  return uniqueId("wb-portal")
}

/** 活动对话事件必须带活动小程序页面上下文，否则不计入活动任务。 */
export function portalChatEvent(): UpstreamEvent {
  const conversationId = newId()
  const traceId = requestId()
  return {
    eventCode: "chat_request_send",
    mode: "chat",
    inputLength: 12,
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 500,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [],
    knowledgeId: [],
    knowledgeName: [],
    codebaseId: "",
    mentionContextCount: 0,
    command: "",
    recommendId: "",
    skillId: "",
    skillCount: 0,
    totalCount: 0,
    requestId: traceId,
    traceId,
    rootRequestId: traceId,
    parentConversationId: conversationId,
    conversationId,
    messageId: `msg-${traceId.slice(-8)}`,
    agentName: "mp",
    agentType: "main",
    "codebuddy.session_id": conversationId,
    "codebuddy.conversation_request_id": traceId,
  }
}

export function portalExpertEvents(expertId: string, expertName: string): UpstreamEvent[] {
  const conversationId = newId()
  const traceId = requestId()
  return [
    {
      eventCode: "expert_summon_click",
      id: expertId,
      name: expertId,
      expertTitle: expertName,
      type: "16-BackToSchool",
      position: 0,
    },
    {
      eventCode: "expert_summoned",
      id: expertId,
      name: expertId,
      expertTitle: expertName,
    },
    {
      eventCode: "expert_actual_use",
      id: expertId,
      name: expertId,
      expertTitle: expertName,
      type: "16-BackToSchool",
      characterCount: 14,
      expertType: "builtin",
    },
    {
      eventCode: "chat_request_send",
      inputLength: 14,
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 500,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [],
      knowledgeId: [],
      knowledgeName: [],
      codebaseId: "",
      mentionContextCount: 0,
      command: "",
      recommendId: "",
      skillId: "",
      skillCount: 0,
      totalCount: 0,
      traceId,
      rootRequestId: traceId,
      parentConversationId: conversationId,
      conversationId,
      messageId: `msg-${traceId.slice(-8)}`,
      agentName: "mp",
      agentType: "main",
      expertId,
      expertName,
      "codebuddy.session_id": conversationId,
      "codebuddy.conversation_request_id": traceId,
    },
  ]
}

export function portalSkillEvents(skillId: string, skillName: string): UpstreamEvent[] {
  const conversationId = newId()
  const traceId = requestId()
  return [
    {
      eventCode: "skill_info",
      id: skillName,
      skillId,
      skillName,
      skillType: "market",
      skillSource: "market",
      position: 0,
      conversationId,
    },
    {
      eventCode: "chat_request_send",
      inputLength: 14,
      isPlan: false,
      isAutoExecuteTerminal: false,
      isAutoModify: false,
      codebaseEnable: false,
      maxToken: 0,
      maxSteps: 500,
      temperature: 0,
      maxRetries: 0,
      mentionContexts: [],
      knowledgeId: [],
      knowledgeName: [],
      codebaseId: "",
      mentionContextCount: 0,
      command: "",
      recommendId: "",
      skillId,
      skillCount: 1,
      totalCount: 0,
      traceId,
      rootRequestId: traceId,
      parentConversationId: conversationId,
      conversationId,
      messageId: `msg-${traceId.slice(-8)}`,
      agentName: "mp",
      agentType: "main",
      "codebuddy.session_id": conversationId,
      "codebuddy.conversation_request_id": traceId,
    },
  ]
}

export async function reportPortalMpEvents(
  account: WorkbuddyAccount,
  events: UpstreamEvent[],
  page: PortalPageContext,
) {
  if (!events.length) throw new Error("portal mp report：没有事件")
  const base = realmBase(account)
  const timestamp = Date.now()
  const fingerprint: UpstreamEvent = {
    timestamp,
    ideType: "WorkBuddy_MP",
    ideVersion: "2.4.0",
    extName: "workbuddy-mp",
    extVersion: "2.4.0",
    product: "SaaS",
    ideName: "wx_app_cloud",
    platform: "mini_program",
    source: "mini_program",
    os: "android",
    osVersion: "14",
    arch: "arm64",
    machineId: `mp-${account.uid.slice(0, 16) || "guest"}`,
    timezone: "Asia/Shanghai",
    userId: account.uid,
    userNickname: account.nickname,
    ...page,
  }
  await taskFetch(
    account,
    `${base.billing}/v2/report`,
    {
      method: "POST",
      fingerprint: "mp",
      headers: {
        "x-client-product": "workbuddy-mp",
        "x-client-version": "2.4.0",
        "x-client-platform": "mp-weixin",
        "x-platform": "wechatmp",
        "user-agent":
          "Mozilla/5.0 (Linux; Android 14; MicroMessenger/8.0.49 WeChat/0.8.0 MiniProgramEnv/android; wkbrowser xweb)",
      },
      body: events.map((event) => ({ ...fingerprint, ...event })),
    },
    "上报运营活动小程序事件",
  )
}
