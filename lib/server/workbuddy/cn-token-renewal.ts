import "server-only"

import type { WorkbuddyAccount } from "./account"
import { refreshCnTokens, WorkbuddyCnRefreshError } from "./cn-oauth"
import { formatShanghaiDay } from "./workbuddy-time"

/**
 * 国内站凭据续期：用 refreshToken 换新 token，并把结果原子回写。
 *
 * 调度口径是**每个自然日（Asia/Shanghai）续一次**，不看剩余寿命：
 * refreshToken 是一次性的，每刷一次就换一把新的，频繁刷新只是白白消耗轮换链
 * （中途任何一步丢写都会让账号彻底报废），而 token 本身有 28 天寿命，
 * 每天续一次既留足余量，也把轮换次数压到最低。
 *
 * 为什么必须回写：上游刷新时会**轮换 refreshToken**，新值不落盘，旧的立刻失效，
 * 下次刷新就救不回来了。
 *
 * 并发控制：同一 uid 的刷新在进程内串行，避免两个请求同时刷新导致
 * 第二个拿着已被轮换掉的 refreshToken 去换。
 */

const refreshing = new Map<string, Promise<WorkbuddyAccount>>()

/**
 * 进程内最近一次续期尝试，跨请求共享。
 *
 * 成功会在凭据文件里留下 `lastRefreshTime`，进程重启后仍能读到；
 * 失败只在这里记一个冷却窗口，过窗口就允许再试——避免一次网络抖动
 * 就让账号一整天不再续期，也避免每个请求都去打一次上游。
 */
const lastAttempt = new Map<string, { day: string; at: number; ok: boolean }>()

/** 续期失败后的冷却时间：过了就允许重试。 */
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000

export interface CnRenewalInput {
  uid: string
  filePath: string
  /** 文件里的原始文本（含 refreshToken 与展示字段）。 */
  raw: string
  /** 严格模式解析失败的过期账号：`allowExpired` 解析出来的那份。 */
  account: WorkbuddyAccount
  now?: number
}

/**
 * 今天是否还需要为这个账号续期。
 *
 * 判据只有「今天有没有续过」，剩余寿命不参与：只要今天没续过就续，
 * 已续过（无论是本进程续的，还是凭据文件里的 `lastRefreshTime`）就跳过。
 */
export function shouldRenewCnAccount(
  account: Pick<WorkbuddyAccount, "uid" | "refreshToken" | "expiresAt"> &
    Partial<Pick<WorkbuddyAccount, "lastRefreshTime">>,
  now = Date.now(),
  attempt = lastAttempt.get(account.uid),
) {
  if (!account.refreshToken.trim()) return false
  if (account.expiresAt <= 0) return false
  const today = formatShanghaiDay(new Date(now))
  // 当天已经续成功过就不再刷。
  if (attempt?.ok && attempt.day === today) return false
  // 当天续期失败过，冷却窗口内先不打上游。
  if (attempt && !attempt.ok && now - attempt.at < FAILURE_COOLDOWN_MS) return false
  const refreshedAt = account.lastRefreshTime ?? 0
  if (refreshedAt > 0 && formatShanghaiDay(new Date(refreshedAt)) === today) return false
  return true
}

/**
 * 记录一次续期尝试结果。
 */
export function markRenewAttempt(uid: string, ok: boolean, now = Date.now()) {
  lastAttempt.set(uid, { day: formatShanghaiDay(new Date(now)), at: now, ok })
}

/** 测试与诊断用：读出最近一次续期尝试。 */
export function lastRenewAttemptOf(uid: string) {
  return lastAttempt.get(uid)
}

/** 测试用：清空进程内状态。 */
export function resetRenewalStateForTesting() {
  lastAttempt.clear()
}

/**
 * 续期并回写凭据文件；返回续期后的账号。
 *
 * 上游判定 refreshToken 已死时抛 `WorkbuddyCnRefreshError(deadToken: true)`，
 * 由调用方决定报错文案——这种账号只能回桌面端重新登录。
 */
export async function renewCnPoolAccount(
  input: CnRenewalInput,
): Promise<WorkbuddyAccount> {
  const uid = input.uid
  const running = refreshing.get(uid)
  if (running) return running

  const task = (async () => {
    const now = input.now ?? Date.now()
    try {
      const tokens = await refreshCnTokens(input.account.refreshToken)
      const nextExpiresAt =
        tokens.expiresIn > 0 ? now + tokens.expiresIn * 1000 : input.account.expiresAt

      await writeRenewedCredential(input, tokens, nextExpiresAt, now)

      return {
        ...input.account,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: nextExpiresAt,
        lastRefreshTime: now,
        ...(tokens.domain ? { domain: tokens.domain } : {}),
      }
    } catch (error) {
      // refreshToken 已死时不再重试：这个账号只能回桌面端重新登录，
      // 记成成功才不会让每个请求都去打一次上游。
      const dead = error instanceof WorkbuddyCnRefreshError && error.deadToken
      markRenewAttempt(uid, dead, now)
      throw error
    }
  })()

  refreshing.set(uid, task)
  try {
    return await task
  } finally {
    refreshing.delete(uid)
  }
}

async function writeRenewedCredential(
  input: CnRenewalInput,
  tokens: { accessToken: string; refreshToken: string; domain: string },
  expiresAt: number,
  now: number,
) {
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(input.raw) as Record<string, unknown>
  } catch {
    // 走不到这里：能解析出账号说明原文是合法 JSON。
    throw new WorkbuddyCnRefreshError(
      "刷新登录态后回写失败：凭据文件不是合法 JSON",
    )
  }
  const auth = isRecord(doc.auth) ? doc.auth : {}
  const nextAuth: Record<string, unknown> = {
    ...auth,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    ...(tokens.domain ? { domain: tokens.domain } : {}),
    ...(expiresAt > 0 ? { expiresAt } : {}),
    lastRefreshTime: now,
  }

  const { writeFile, rename } = await import("node:fs/promises")
  const temp = `${input.filePath}.${process.pid}.${now}.tmp`
  await writeFile(
    temp,
    `${JSON.stringify({ ...doc, auth: nextAuth }, null, 2)}\n`,
    "utf8",
  )
  await rename(temp, input.filePath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

