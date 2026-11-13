import "server-only"

import type { WorkbuddyAccount } from "./account"
import { isGlobalAccount } from "./task-api"
import { sleep } from "./task-query"
import {
  claimPortalActivityTask,
  fetchPortalActivityTasks,
  markPortalActivityTaskViewed,
  pollPortalActivityTask,
  type PortalActivityTask,
} from "./portal-activity-api"
import {
  portalChatEvent,
  portalExpertEvents,
  portalSkillEvents,
  reportPortalMpEvents,
  type PortalPageContext,
} from "./portal-events"
import { newDesktopChatIds, sendDesktopEvents } from "./desktop-events"

export interface CampaignActionSpec {
  code: string
  label: string
  page: PortalPageContext
  tasks: Array<{
    taskCode: string
    label: string
    kind: "chat" | "expert" | "skill" | "desktop" | "app"
    times?: number
    expertId?: string
    expertName?: string
    skillId?: string
    skillName?: string
    caseId?: string
  }>
}

export const CAMPAIGN_ACTIONS: CampaignActionSpec[] = [
  {
    code: "campaign_starbucks_2026",
    label: "星巴克协作",
    page: {
      pageURL: "subpackages/secondary/starbucks-activity-428/index",
      pageName: "starbucks_activity",
    },
    tasks: [
      { taskCode: "ai_chat", label: "与 AI 对话3次", kind: "chat", times: 3 },
      { taskCode: "expert", label: "召唤专家并对话", kind: "expert" },
      { taskCode: "app", label: "解锁 App 强大能力", kind: "app" },
    ],
  },
  {
    code: "campaign_reporter_2026",
    label: "记者节福利活动",
    page: {
      pageURL: "subpackages/journalist-benefit/index",
      pageName: "journalist_benefit",
    },
    tasks: [
      {
        taskCode: "expert_chat",
        label: "体验「媒体工作助理」专家",
        kind: "expert",
        expertId: "ex_NaiDbO06Adf3",
        expertName: "媒体工作助理",
      },
      {
        taskCode: "skill_use",
        label: "体验「采访素材整理」技能",
        kind: "skill",
        skillId: "skill_2117491159283752960",
        skillName: "interview-material-organizer",
      },
      {
        taskCode: "desktop_same",
        label: "体验「内容发布排期」灵感",
        kind: "desktop",
        caseId: "content-calendar",
      },
    ],
  },
]

const CASE_CONTENT = {
  event_id: "cnb-content-calendar",
  name: "内容发布排期表",
  type: "table",
  promptLength: 359,
}

export interface CampaignStep {
  taskCode: string
  status: "done" | "skipped" | "error"
  message: string
  credit?: number
  retryable?: boolean
}

const POLL_ATTEMPTS = 5
const POLL_GAP_MS = 3_000
const CLAIM_ATTEMPTS = 4
const DESKTOP_POLL_ATTEMPTS = 10
const DESKTOP_POLL_GAP_MS = 6_000

function campaignFailure(message: string, error: unknown): CampaignStep {
  return {
    taskCode: message,
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  }
}

function currentOrTarget(task: PortalActivityTask | undefined, fallback = 0) {
  return task?.progress ?? fallback
}

function hasCompleted(task: PortalActivityTask) {
  return Boolean(task.completedAt) || (task.target > 0 && task.progress >= task.target)
}

function campaignDesktopEvent() {
  const ids = newDesktopChatIds("wb-campaign")
  return {
    eventCode: "playbook_prompt_send",
    id: CASE_CONTENT.event_id,
    name: CASE_CONTENT.name,
    type: CASE_CONTENT.type,
    promptLength: CASE_CONTENT.promptLength,
    isOfficial: 1,
    source: "discover",
    query: "",
    ext1: "discover",
    requestId: ids.requestId,
    conversationId: ids.conversationId,
  }
}

async function runCampaignTask(
  account: WorkbuddyAccount,
  campaign: CampaignActionSpec,
  spec: CampaignActionSpec["tasks"][number],
  row: PortalActivityTask,
): Promise<CampaignStep> {
  if (row.claimedAt) {
    return {
      taskCode: spec.taskCode,
      status: "skipped",
      message: "已领取",
    }
  }

  if (!row.completedAt && row.target > 0 && row.progress >= row.target) {
    // Poll before claim as a defensive readback; do not trust local arithmetic.
    row = await pollPortalActivityTask(
      account,
      campaign.code,
      spec.taskCode,
      hasCompleted,
      POLL_ATTEMPTS,
      POLL_GAP_MS,
    ) ?? row
  }

  if (!row.completedAt && row.target > 0 && row.progress < row.target) {
    if (row.needView) {
      await markPortalActivityTaskViewed(account, campaign.code, spec.taskCode)
    }
    if (spec.kind === "app") {
      return {
        taskCode: spec.taskCode,
        status: "skipped",
        message: "需在手机 App 内完成一次真实对话，脚本不伪造",
      }
    }
    if (spec.kind === "desktop") {
      await sendDesktopEvents(account, [campaignDesktopEvent()])
    } else {
      const times = Math.max(1, (spec.times ?? row.target) - currentOrTarget(row))
      for (let index = 0; index < times; index++) {
        if (spec.kind === "chat") {
          await reportPortalMpEvents(account, [portalChatEvent()], campaign.page)
        } else if (spec.kind === "expert") {
          await reportPortalMpEvents(
            account,
            portalExpertEvents(
              spec.expertId ?? "WorkspaceBuilder",
              spec.expertName ?? "工作台搭建师",
            ),
            campaign.page,
          )
        } else if (spec.kind === "skill") {
          if (!spec.skillId || !spec.skillName) {
            throw new Error("活动技能判据缺少技能 ID 或名称")
          }
          await reportPortalMpEvents(
            account,
            portalSkillEvents(spec.skillId, spec.skillName),
            campaign.page,
          )
        }
        if (index + 1 < times) await sleep(1_050)
      }
    }
    row = await pollPortalActivityTask(
      account,
      campaign.code,
      spec.taskCode,
      hasCompleted,
      spec.kind === "desktop" ? DESKTOP_POLL_ATTEMPTS : POLL_ATTEMPTS,
      spec.kind === "desktop" ? DESKTOP_POLL_GAP_MS : POLL_GAP_MS,
    ) ?? row
  }

  if (!hasCompleted(row)) {
    return {
      taskCode: spec.taskCode,
      status: "skipped",
      message: `已上报，服务端进度未确认（${row.progress}/${row.target}）`,
      retryable: true,
    }
  }
  if (row.claimedAt) {
    return {
      taskCode: spec.taskCode,
      status: "skipped",
      message: "已完成并领取",
    }
  }

  await claimPortalActivityTask(account, campaign.code, spec.taskCode)
  const claimed = await pollPortalActivityTask(
    account,
    campaign.code,
    spec.taskCode,
    (next) => Boolean(next.claimedAt),
    CLAIM_ATTEMPTS,
    POLL_GAP_MS,
  ) ?? row
  if (!claimed.claimedAt) {
    return {
      taskCode: spec.taskCode,
      status: "error",
      message: "领奖请求已提交，但未回读到 claimed_at",
      retryable: true,
    }
  }
  return {
    taskCode: spec.taskCode,
    status: "done",
    message: `已领取 +${claimed.credit}分`,
    credit: claimed.credit,
  }
}

/**
 * 运营活动任务与成长任务清单相互独立；即使成长列表为空，也照常执行这里。
 * 单个活动/任务失败只影响本项，不阻断其它活动。
 */
export async function runCampaignActions(account: WorkbuddyAccount): Promise<CampaignStep[]> {
  if (isGlobalAccount(account)) return []
  const results: CampaignStep[] = []
  for (const campaign of CAMPAIGN_ACTIONS) {
    let rows: Map<string, PortalActivityTask>
    try {
      rows = await fetchPortalActivityTasks(account, campaign.code)
    } catch (error) {
      results.push(campaignFailure(`${campaign.label}读取`, error))
      continue
    }
    if (!rows.size) {
      results.push({
        taskCode: campaign.code,
        status: "skipped",
        message: "活动未下发或已结束",
      })
      continue
    }
    for (const spec of campaign.tasks) {
      const row = rows.get(spec.taskCode)
      if (!row) {
        results.push({
          taskCode: `${campaign.code}/${spec.taskCode}`,
          status: "skipped",
          message: "活动任务未下发或已下线",
        })
        continue
      }
      try {
        results.push(await runCampaignTask(account, campaign, spec, row))
      } catch (error) {
        results.push(campaignFailure(`${campaign.code}/${spec.taskCode}`, error))
      }
    }
  }
  return results
}
