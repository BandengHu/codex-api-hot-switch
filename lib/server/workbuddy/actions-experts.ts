import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
  desktopChatSequence,
  desktopExpertActualUseEvent,
  desktopExpertSummonSequence,
  desktopChatWithExpert,
  sendDesktopEvents,
  type MarketExpert,
} from "./desktop-events"
import {
  isWorkbuddyDynamicExpertId,
  resolveWorkbuddyDynamicExpertTask,
  type WorkbuddyDynamicExpert,
} from "@/lib/workbuddy-dynamic-expert"
import type { WorkbuddyGrowthTask } from "./task-api"

export interface FixedExpertTask {
  taskCode: string
  expertId: string
  expertName: string
  category: string
}

export const FIXED_EXPERT_TASKS: FixedExpertTask[] = [
  {
    taskCode: "WorkBuddy_Valorant",
    expertId: "ex_xQHHD1u5Jkua",
    expertName: "无畏契约拼豆专家",
    category: "16-BackToSchool",
  },
  {
    taskCode: "workstation_expert",
    expertId: "WorkspaceBuilder",
    expertName: "工作台搭建师",
    category: "expert-all",
  },
  {
    taskCode: "expert_use_maidehao",
    expertId: "ex_GDl31WahyIH0",
    expertName: "中国电商运营专家",
    category: "expert-all",
  },
  {
    taskCode: "expert_use_douyinyin",
    expertId: "ex_FbY5nlWTqDod",
    expertName: "抖音策略师",
    category: "expert-all",
  },
  {
    taskCode: "expert_use_shangjia_xuanchuan",
    expertId: "ex_Weo3x2EZuSDm",
    expertName: "商家宣传页与海报设计师",
    category: "expert-all",
  },
  {
    taskCode: "expert_use_bowangwang",
    expertId: "ex_WZY136wV5aMt",
    expertName: "直播电商教练",
    category: "expert-all",
  },
]

export const FIXED_EXPERT_BY_CODE = new Map(
  FIXED_EXPERT_TASKS.map((task) => [task.taskCode, task]),
)

/**
 * 从任务深链提取临时专家。上游新增专家任务时不一定同步发布任务码，
 * `jump_url` 会携带真实 expertId；只接受专家深链，普通活动链接保持跳过。
 */
export function resolveDynamicExpertTask(
  task: Pick<WorkbuddyGrowthTask, "taskCode" | "title" | "jumpUrl">,
): WorkbuddyDynamicExpert | undefined {
  return resolveWorkbuddyDynamicExpertTask(task)
}

/**
 * 固定专家任务：召唤事件 + 服务端真实 requestId + expert_actual_use。
 * 专家 ID 来自上游任务判据，不能替换成市场列表中的任意专家。
 */
export async function runFixedExpert(
  account: WorkbuddyAccount,
  taskCode: string,
): Promise<string> {
  const spec = FIXED_EXPERT_BY_CODE.get(taskCode)
  if (!spec) throw new Error(`未知固定专家任务：${taskCode}`)

  const expert: MarketExpert = {
    expertId: spec.expertId,
    expertType: "agent",
    displayName: spec.expertName,
    profession: spec.expertName,
    version: "1.0.0",
    categories: [spec.category],
  }
  await sendDesktopEvents(account, desktopExpertSummonSequence(expert))
  const chat = await desktopChatWithExpert(account, expert.expertId)
  await sendDesktopEvents(account, [
    ...desktopChatSequence(chat.conversationId, chat.requestId, `msg-${chat.requestId.slice(-8)}`),
    desktopExpertActualUseEvent(expert, chat.conversationId, chat.requestId),
  ])
  return `已完成「${spec.expertName}」真实召唤与对话`
}

/** 临时专家任务：使用任务深链中的真实专家 ID，执行同一套桌面行为链。 */
export async function runDynamicExpert(
  account: WorkbuddyAccount,
  expertId: string,
  expertName: string,
): Promise<string> {
  if (!isWorkbuddyDynamicExpertId(expertId)) {
    throw new Error(`动态专家任务缺少合法 expertId：${expertId || "(空)"}`)
  }
  const expert: MarketExpert = {
    expertId,
    expertType: "agent",
    displayName: expertName,
    profession: expertName,
    version: "1.0.0",
    categories: ["expert-all"],
  }
  await sendDesktopEvents(account, desktopExpertSummonSequence(expert))
  const chat = await desktopChatWithExpert(account, expert.expertId)
  await sendDesktopEvents(account, [
    ...desktopChatSequence(chat.conversationId, chat.requestId, `msg-${chat.requestId.slice(-8)}`),
    desktopExpertActualUseEvent(expert, chat.conversationId, chat.requestId),
  ])
  return `已完成临时专家「${expertName}」真实召唤与对话`
}
