import "server-only"

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * 读 WorkBuddy 桌面端写在本机的登录态。
 *
 * 这里不做缓存：文件 5KB 左右，每次请求读一次能保证换号/续期后立刻生效。
 * 过期不做刷新——上游没有给刷新接口，桌面端自己也是重新登录，所以直接报错让用户去登录。
 */

export interface WorkbuddyAccount {
  accessToken: string
  refreshToken: string
  expiresAt: number
  domain: string
  uid: string
  nickname: string
  uin: string
}

export class WorkbuddyAccountError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkbuddyAccountError"
  }
}

export function workbuddyCredentialPath() {
  const localAppData =
    process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
  return join(
    localAppData,
    "CodeBuddyExtension",
    "Data",
    "Public",
    "auth",
    "workbuddy-desktop.info",
  )
}

export async function readWorkbuddyAccount(): Promise<WorkbuddyAccount> {
  const path = workbuddyCredentialPath()
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new WorkbuddyAccountError(
        `没有找到 WorkBuddy 本机登录态：${path}。请先登录 WorkBuddy 桌面端。`,
      )
    }
    throw new WorkbuddyAccountError(
      `读取 WorkBuddy 本机登录态失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parseWorkbuddyAccount(raw, path)
}

export function parseWorkbuddyAccount(raw: string, path: string): WorkbuddyAccount {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new WorkbuddyAccountError(
      `WorkBuddy 本机登录态不是合法 JSON（${path}），可能已损坏，请在桌面端重新登录。`,
    )
  }
  const record = asRecord(payload)
  const auth = asRecord(record.auth)
  const account = asRecord(record.account)
  const accessToken = asString(auth.accessToken)
  if (!accessToken) {
    throw new WorkbuddyAccountError(
      `WorkBuddy 本机登录态里没有 accessToken（${path}），请在桌面端重新登录。`,
    )
  }
  const expiresAt = asNumber(auth.expiresAt)
  if (expiresAt > 0 && expiresAt <= Date.now()) {
    throw new WorkbuddyAccountError(
      `WorkBuddy 登录态已过期（${formatTime(expiresAt)}），请在 WorkBuddy 桌面端重新登录后再试。`,
    )
  }
  return {
    accessToken,
    refreshToken: asString(auth.refreshToken),
    expiresAt,
    domain: asString(auth.domain),
    uid: asString(account.uid),
    nickname: asString(account.nickname),
    uin: asString(account.uin),
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
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}
