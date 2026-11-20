import "server-only"

import type { WorkbuddyAccount } from "./account"
import {
  CN_ACCOUNT_REFRESH_WINDOW_MS,
  refreshCnTokens,
  WorkbuddyCnRefreshError,
} from "./cn-oauth"

/**
 * 国内站凭据续期：临期或已过期时用 refreshToken 换新 token，并把结果原子回写。
 *
 * 为什么必须回写：上游刷新时会**轮换 refreshToken**，新值不落盘，旧的立刻失效，
 * 下次刷新就救不回来了。
 *
 * 并发控制：同一 uid 的刷新在进程内串行，避免两个请求同时刷新导致
 * 第二个拿着已被轮换掉的 refreshToken 去换。
 */

const refreshing = new Map<string, Promise<WorkbuddyAccount>>()

export interface CnRenewalInput {
  uid: string
  filePath: string
  /** 文件里的原始文本（含 refreshToken 与展示字段）。 */
  raw: string
  /** 严格模式解析失败的过期账号：`allowExpired` 解析出来的那份。 */
  account: WorkbuddyAccount
  now?: number
}

/** 是否值得尝试续期：有 refreshToken，且已过期或临近过期。 */
export function shouldRenewCnAccount(
  account: Pick<WorkbuddyAccount, "refreshToken" | "expiresAt">,
  now = Date.now(),
) {
  if (!account.refreshToken.trim()) return false
  if (account.expiresAt <= 0) return false
  return account.expiresAt - now <= CN_ACCOUNT_REFRESH_WINDOW_MS
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
    const tokens = await refreshCnTokens(input.account.refreshToken)
    const nextExpiresAt =
      tokens.expiresIn > 0 ? now + tokens.expiresIn * 1000 : input.account.expiresAt

    await writeRenewedCredential(input, tokens, nextExpiresAt, now)

    return {
      ...input.account,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: nextExpiresAt,
      ...(tokens.domain ? { domain: tokens.domain } : {}),
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

