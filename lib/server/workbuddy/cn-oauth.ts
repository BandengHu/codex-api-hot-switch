import "server-only"

import { fetchProvider } from "@/lib/server/proxy/provider-fetch"
import { getSystemProxyDispatcher } from "@/lib/server/proxy/system-proxy"

/**
 * 国内站（codebuddy.cn / copilot.tencent.com）的 refreshToken 续期。
 *
 * 端点实测确认（2026-11-20）：
 *   POST https://copilot.tencent.com/v2/plugin/auth/token/refresh
 *   Header: x-refresh-token: <refreshToken>
 *   Body:   {}
 *   → 200 {code:0, data:{accessToken, refreshToken, expiresIn, domain}}
 *
 * 几个容易踩的坑，都是实测结论：
 * - refreshToken 走 **header** 而不是 body：放 body 里上游返回 `10001: refreshToken is empty`；
 * - 响应会返回**新的** refreshToken，但它**不是一次性的**：同一个 refreshToken
 *   连续刷两次都会成功（2026-11-20 实测），所以两台机器各持一份也不会互踢。
 *   仍然建议把新值落盘，这样账号始终握在最新一条链上；
 * - `expiresIn` 固定 2419200 秒（28 天）；
 * - 已失效的 refreshToken 返回 `invalid_grant: Token is not active`，这种无法挽救，
 *   只能回桌面端重新登录，所以要和「网络抖动」区分开（见 `isRefreshTokenDead`）。
 */

export const CN_REFRESH_ORIGIN = "https://copilot.tencent.com"
export const CN_REFRESH_PATH = "/v2/plugin/auth/token/refresh"

const REFRESH_TIMEOUT_MS = 20_000
const CLI_UA = "WorkBuddy/5.6.2 WorkBuddy/5.6.2 CLI/1.0"

export class WorkbuddyCnRefreshError extends Error {
  /** refreshToken 已被上游判定失效（重新登录才能救），不是临时故障。 */
  readonly deadToken: boolean

  constructor(message: string, deadToken = false) {
    super(message)
    this.name = "WorkbuddyCnRefreshError"
    this.deadToken = deadToken
  }
}

export interface CnOauthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  domain: string
}

/** 上游明确表示这个 refreshToken 已经不能用了；重试多少次都没意义。 */
export function isRefreshTokenDead(message: string) {
  return /Token is not active|refresh token is invalid|invalid_grant/i.test(message)
}

export async function refreshCnTokens(refreshToken: string): Promise<CnOauthTokens> {
  if (!refreshToken.trim()) {
    throw new WorkbuddyCnRefreshError("刷新登录态失败：没有 refreshToken", true)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
  const url = `${CN_REFRESH_ORIGIN}${CN_REFRESH_PATH}`
  try {
    const init: Record<string, unknown> = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        "user-agent": CLI_UA,
        "x-refresh-token": refreshToken.trim(),
        "x-requested-with": "XMLHttpRequest",
        origin: CN_REFRESH_ORIGIN,
        referer: `${CN_REFRESH_ORIGIN}/`,
      },
      body: "{}",
      signal: controller.signal,
      cache: "no-store",
    }
    const dispatcher = getSystemProxyDispatcher(url)
    if (dispatcher) init.dispatcher = dispatcher

    const response = await fetchProvider(url, init as RequestInit)
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new WorkbuddyCnRefreshError(
        `刷新登录态失败：响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}`,
      )
    }

    const record = asRecord(payload)
    const code = record.code
    const message = asString(record.msg)
    if (code !== 0 && code !== undefined) {
      throw new WorkbuddyCnRefreshError(
        `刷新登录态失败：${message || `code=${String(code)}`}`,
        isRefreshTokenDead(message),
      )
    }
    const data = asRecord(record.data)
    const accessToken = asString(data.accessToken)
    if (!accessToken) {
      throw new WorkbuddyCnRefreshError("刷新登录态失败：响应缺少 accessToken")
    }
    return {
      accessToken,
      refreshToken: asString(data.refreshToken) || refreshToken.trim(),
      expiresIn: asNumber(data.expiresIn),
      domain: asString(data.domain),
    }
  } catch (error) {
    if (error instanceof WorkbuddyCnRefreshError) throw error
    if (error instanceof Error && error.name === "AbortError") {
      throw new WorkbuddyCnRefreshError("刷新登录态失败：请求超时")
    }
    throw new WorkbuddyCnRefreshError(
      `刷新登录态失败：${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timeout)
  }
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
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

