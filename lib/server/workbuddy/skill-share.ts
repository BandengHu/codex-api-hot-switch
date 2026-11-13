import "server-only"

import type { WorkbuddyAccount } from "./account"
import { realmBase, taskFetch } from "./api-client"
import { reportDesktopEvents, type UpstreamEvent } from "./report"
import { findTaskFor, sleep } from "./task-query"

const SKILL_MARKET_PATH = "/v2/operation-platform/market/skill/list"
const SKILL_SHARE_CHANNEL_URL =
  "https://open.workbuddy.cn/api/v2/open-platform/asset-shares/c2c/channels"
const PREFERRED_SKILL_ID = "skill_2097350077599879168"
const POLL_ATTEMPTS = 4
const POLL_GAP_MS = 3_000

export interface MarketSkill {
  id: string
  name: string
  description: string
}

export interface SkillShareChannel {
  shareCode: string
  resourceRef: string
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function parseMarketSkills(data: unknown): MarketSkill[] {
  const record = (data ?? {}) as Record<string, unknown>
  const rows = Array.isArray(record.skills) ? record.skills : []
  const skills: MarketSkill[] = []
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    const id = stringValue(row.skill_id) || stringValue(row.id)
    const name =
      stringValue(row.display_name_zh) ||
      stringValue(row.name) ||
      stringValue(row.display_name_en)
    if (!id || !name) continue
    skills.push({
      id,
      name,
      description:
        stringValue(row.description_zh) ||
        stringValue(row.description) ||
        stringValue(row.description_en),
    })
  }
  return skills
}

export function preferredMarketSkill(skills: MarketSkill[]) {
  return (
    skills.find((skill) => skill.id === PREFERRED_SKILL_ID) ?? skills[0]
  )
}

export function parseSkillShareChannel(data: unknown): SkillShareChannel {
  const record = (data ?? {}) as Record<string, unknown>
  const shareCode = stringValue(record.share_code)
  const ways = Array.isArray(record.ways) ? record.ways : []
  const link = ways.find(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      stringValue((value as Record<string, unknown>).share_way) === "link",
  ) as Record<string, unknown> | undefined
  const resourceRef = stringValue(link?.resource_ref)
  if (!shareCode || !resourceRef) {
    throw new Error("分享接口缺少 share_code 或 link")
  }
  return { shareCode, resourceRef }
}

export function skillShareEvents(
  skill: MarketSkill,
  shareCode: string,
  actionAt = Date.now(),
): UpstreamEvent[] {
  const common = {
    skillId: skill.id,
    skillName: skill.name,
    skillType: "market",
    action: "link",
    panelType: "clipboard",
    isSuccessful: true,
    cost: 0,
    id: shareCode,
    actionAt,
  }
  return [
    {
      eventCode: "skill_share_channel_action",
      panelAction: "click",
      ...common,
    },
    {
      eventCode: "skill_share_channel_action",
      panelAction: "success",
      ...common,
    },
  ]
}

async function fetchMarketSkill(account: WorkbuddyAccount) {
  const base = realmBase(account)
  const record = await taskFetch(
    account,
    `${base.billing}${SKILL_MARKET_PATH}`,
    { method: "POST", body: { page: 1, page_size: 20 }, retry: true },
    "读取技能市场",
  )
  const data = (record.data ?? {}) as Record<string, unknown>
  const skill = preferredMarketSkill(parseMarketSkills(data))
  if (!skill) throw new Error("技能市场没有返回可分享技能")
  return skill
}

async function createSkillShareChannel(
  account: WorkbuddyAccount,
  skill: MarketSkill,
): Promise<SkillShareChannel> {
  const record = await taskFetch(
    account,
    SKILL_SHARE_CHANNEL_URL,
    {
      method: "POST",
      fingerprint: "desktop",
      timeoutMs: 30_000,
      headers: {
        "x-domain": "copilot.tencent.com",
        "x-user-id": account.uid,
      },
      body: {
        asset_kind: "skill",
        asset_source: "market",
        asset_ref: JSON.stringify({ asset_id: skill.id }),
        ways: ["link", "wxacode", "wxapath"],
        extra: {
          name: skill.name,
          description: skill.description,
          shareKey: skill.id,
          marketplaceSource: "builtin-market",
        },
      },
    },
    "创建技能分享渠道",
  )
  return parseSkillShareChannel(record.data)
}

/**
 * 真实技能分享：创建渠道 -> 两条渠道动作 -> 服务端回读进度。
 * 渠道缺少 share_code/link 时不上报事件，也不领奖。
 */
export async function runSkillShare(account: WorkbuddyAccount): Promise<string> {
  const skill = await fetchMarketSkill(account)
  const channel = await createSkillShareChannel(account, skill)
  await reportDesktopEvents(account, skillShareEvents(skill, channel.shareCode))

  let latest: Awaited<ReturnType<typeof findTaskFor>> | undefined
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(POLL_GAP_MS)
    latest = await findTaskFor(account, "skill_share").catch(() => undefined)
    if (latest?.claimed) return "已分享技能，本轮已入账"
    if (latest?.claimable) break
  }
  if (!latest?.claimable) {
    throw new Error(
      `分享渠道已创建，但服务端进度未确认（${latest?.current ?? 0}/${latest?.target ?? 1}）`,
    )
  }
  return `已创建真实分享渠道并完成技能分享（${skill.name}）`
}
