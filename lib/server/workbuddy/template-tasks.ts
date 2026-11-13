import "server-only"

import type { WorkbuddyAccount } from "./account"
import { realmBase, taskFetch, uniqueId } from "./api-client"
import { reportDesktopEvents, type UpstreamEvent } from "./report"
import { findTaskFor, sleep } from "./task-query"

const TEMPLATE_SCENES_URL =
  "https://www.workbuddy.cn/console/as/support/scenes?locale=zh-CN"
const TEMPLATE_POLL_TRIES = 4
const TEMPLATE_POLL_GAP_MS = 2_000

export interface TemplateScene {
  id: string
  name: string
}

export function parseTemplateScenes(data: unknown): TemplateScene[] {
  const record = (data ?? {}) as Record<string, unknown>
  const rows = Array.isArray(record.scenes) ? record.scenes : []
  const scenes: TemplateScene[] = []
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    if (row.id === null || row.id === undefined) continue
    const id = String(row.id).trim()
    if (!id) continue
    scenes.push({
      id,
      name: typeof row.name === "string" ? row.name.trim() : "",
    })
  }
  return scenes
}

/** 服务端下发的真实场景；读取失败必须向上抛，不能拿静态编号伪装。 */
export async function fetchTemplateScenes(
  account: WorkbuddyAccount,
): Promise<TemplateScene[]> {
  const record = await taskFetch(
    account,
    TEMPLATE_SCENES_URL,
    { method: "GET", fingerprint: "web", pageUrl: `${realmBase(account).web}/profile/growth-center`, retry: true },
    "读取模板场景",
  )
  return parseTemplateScenes(record.data)
}

/** 一组模板创建事件；四个事件必须一起上报。 */
export function templateSceneEvents(
  scene: TemplateScene,
  ids = {
    conversationId: uniqueId("wb-template"),
    requestId: uniqueId("wb-template-request"),
  },
): UpstreamEvent[] {
  return [
    {
      eventCode: "agent_task_created",
      source: "CLOUD",
      name: "",
      mode: "craft",
      requestModelId: "default",
      action: scene.id,
      has_template: true,
      template_id: scene.id,
      template_name: scene.name,
      requestId: ids.requestId,
      conversationId: ids.conversationId,
    },
    {
      eventCode: "agent_task_created_with_template",
      templateId: scene.id,
      templateName: scene.name,
      template_id: scene.id,
      mode: "working",
      isCustomModel: true,
      id: scene.id,
      name: scene.name,
      requestId: ids.requestId,
      conversationId: ids.conversationId,
    },
    {
      eventCode: "template_used",
      template_id: scene.id,
      templateId: scene.id,
      templateName: scene.name,
      task_mode: "working",
      id: scene.id,
      name: scene.name,
      source: "growth-center",
      conversationId: ids.conversationId,
    },
    {
      eventCode: "playbook_prompt_send",
      ext1: crypto.randomUUID(),
      requestId: ids.requestId,
      id: scene.id,
      name: scene.name,
      type: "other",
      promptLength: 30,
      isOfficial: 1,
      source: "growth-center",
      conversationId: ids.conversationId,
    },
  ]
}

async function waitForTemplateProgress(
  account: WorkbuddyAccount,
  target: number,
) {
  let latest: Awaited<ReturnType<typeof findTaskFor>>
  for (let attempt = 0; attempt < TEMPLATE_POLL_TRIES; attempt++) {
    if (attempt > 0) await sleep(TEMPLATE_POLL_GAP_MS)
    latest = await findTaskFor(account, "template_5").catch(() => undefined)
    if (!latest) continue
    if (latest.claimed || latest.claimable || latest.current >= target) {
      return latest
    }
  }
  return latest
}

/**
 * 按服务器当前进度补足 `template_5`。
 * 每组事件后先回读；进度没增长就停止本轮，避免连续滥发。
 */
export async function runTemplateUse(
  account: WorkbuddyAccount,
): Promise<string> {
  const task = await findTaskFor(account, "template_5")
  if (!task) throw new Error("该账号没有 template_5 任务")
  if (task.claimed) return "template_5 已领取"

  const target = task.target > 0 ? task.target : 5
  let current = task.current
  if (current >= target || task.claimable) {
    return `template_5 已达标（${current}/${target}）`
  }

  const scenes = await fetchTemplateScenes(account)
  if (!scenes.length) throw new Error("模板场景接口未返回可用场景")

  let latest = task
  while (current < target) {
    const scene = scenes[current % scenes.length]
    const before = current
    await reportDesktopEvents(account, templateSceneEvents(scene))
    const fresh = await waitForTemplateProgress(account, target)
    if (!fresh) break
    latest = fresh
    current = fresh.current
    if (fresh.claimed || fresh.claimable || current >= target) break
    if (current <= before) {
      throw new Error(
        `模板 ${scene.name || scene.id} 已上报，但服务端进度未增长（${before}/${target}）`,
      )
    }
  }

  if (!(latest.claimed || latest.claimable || current >= target)) {
    throw new Error(`模板任务进度未确认（${current}/${target}）`)
  }
  return `模板任务进度已确认（${Math.min(current, target)}/${target}）`
}
