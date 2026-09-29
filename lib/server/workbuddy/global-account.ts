import "server-only"

import {
  WorkbuddyAccountError,
  type WorkbuddyAccount,
} from "./account"
import {
  isEncryptedFieldWrapper,
  openFieldString,
  parseFieldEnvelope,
  type WorkbuddyAtRestKey,
} from "./at-rest"
import { resolveWorkbuddyAtRestKey } from "./at-rest-key"
import { refreshGlobalTokens } from "./global-oauth"

/**
 * 国际版（www.workbuddy.ai）凭据解析。
 *
 * 与国内站共用一个 `{account, auth}` 文件形状，所以能直接吃：
 * - 本页「授权登录」写出的凭据；
 * - WorkBuddy2API 的 `~/.workbuddy2api-auth.json`；
 * - 桌面端导出的凭据（含 5.6.2 起的 `$wbEncrypted` 静态钥信封）。
 *
 * 与国内站 `parseWorkbuddyAccount` 的关键差别：国际站**支持 refreshToken 续期**，
 * 所以这里临近过期时会自动刷新并把新 token 回写，而不是直接报「请重新登录」。
 */

/** 距过期不足这个窗口就先刷新，避免请求打到一半失效。 */
export const GLOBAL_ACCOUNT_REFRESH_WINDOW_MS = 5 * 60 * 1000

export interface ParsedGlobalCredential {
  account: WorkbuddyAccount
  /** 刷新后的完整凭据文本；没刷新时与入参逐字节一致。 */
  raw: string
  refreshed: boolean
}

export async function parseGlobalCredential(
  raw: string,
  path: string,
  options: { refresh?: boolean } = {},
): Promise<ParsedGlobalCredential> {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new WorkbuddyAccountError(
      `国际版登录态不是合法 JSON（${path}），请在页面重新授权登录或重新导入。`,
    )
  }
  const record = asRecord(payload)
  const auth = asRecord(record.auth)
  const account = asRecord(record.account)

  let atRestKey: WorkbuddyAtRestKey | undefined
  const decode = async (value: unknown, label: string) => {
    if (typeof value === "string") return value.trim()
    if (!isEncryptedFieldWrapper(value)) return ""
    if (!atRestKey) {
      const { keyId } = parseFieldEnvelope(value)
      atRestKey = await resolveWorkbuddyAtRestKey(keyId)
    }
    return openFieldString(value, atRestKey).trim()
  }
  const decodeOptional = async (value: unknown) => {
    try {
      return await decode(value, "展示字段")
    } catch {
      return ""
    }
  }

  let accessToken = ""
  let refreshToken = ""
  try {
    accessToken = await decode(auth.accessToken, "auth.accessToken")
    refreshToken = await decode(auth.refreshToken, "auth.refreshToken")
  } catch (error) {
    throw new WorkbuddyAccountError(
      `国际版登录态解析失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!accessToken) {
    throw new WorkbuddyAccountError(
      `国际版登录态里没有 accessToken（${path}），请在页面重新授权登录。`,
    )
  }

  let expiresAt = asNumber(auth.expiresAt)
  let domain = asString(auth.domain)
  let nextRaw = raw
  let refreshed = false

  const shouldRefresh =
    options.refresh !== false &&
    Boolean(refreshToken) &&
    (expiresAt <= 0 || expiresAt - Date.now() < GLOBAL_ACCOUNT_REFRESH_WINDOW_MS)
  if (shouldRefresh) {
    const tokens = await refreshGlobalTokens(refreshToken)
    accessToken = tokens.accessToken
    refreshToken = tokens.refreshToken
    domain = tokens.domain || domain
    const now = Date.now()
    if (tokens.expiresIn > 0) expiresAt = now + tokens.expiresIn * 1000
    const nextAuth = {
      ...auth,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      ...(domain ? { domain } : {}),
      ...(expiresAt > 0 ? { expiresAt } : {}),
      lastRefreshTime: now,
    }
    // 解出来的明文要重新落盘；否则每次请求都会重复刷新。
    nextRaw = `${JSON.stringify({ ...record, auth: nextAuth }, null, 2)}\n`
    refreshed = true
  }

  if (expiresAt > 0 && expiresAt <= Date.now()) {
    throw new WorkbuddyAccountError(
      `国际版登录态已过期（${formatTime(expiresAt)}），且没有可用的 refreshToken，请在页面重新授权登录。`,
    )
  }

  return {
    account: {
      accessToken,
      refreshToken,
      expiresAt,
      domain: domain || "www.workbuddy.ai",
      uid: asString(account.uid),
      nickname: await decodeOptional(account.nickname),
      uin: asString(account.uin),
    },
    raw: nextRaw,
    refreshed,
  }
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}
