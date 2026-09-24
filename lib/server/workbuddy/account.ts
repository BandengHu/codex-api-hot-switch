import "server-only"

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  isEncryptedFieldWrapper,
  openFieldString,
  parseFieldEnvelope,
  type WorkbuddyAtRestKey,
} from "./at-rest"
import { resolveWorkbuddyAtRestKey } from "./at-rest-key"

/**
 * 读 WorkBuddy 桌面端写在本机的登录态。
 *
 * 这里不做缓存：文件 5KB 左右，每次请求读一次能保证换号/续期后立刻生效。
 * 过期不做刷新——上游没有给刷新接口，桌面端自己也是重新登录，所以直接报错让用户去登录。
 *
 * 5.6.2 起桌面端把 token 等敏感字段换成了 `$wbEncrypted` 静态钥信封，读到信封时
 * 由 at-rest 模块解出明文；解密钥的来源与缓存见 `at-rest-key.ts`。
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

export async function parseWorkbuddyAccount(raw: string, path: string): Promise<WorkbuddyAccount> {
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

  let atRestKey: WorkbuddyAtRestKey | undefined
  const decode = async (value: unknown, label: string) => {
    if (typeof value === "string") return value.trim()
    if (!isEncryptedFieldWrapper(value)) return ""
    if (!atRestKey) {
      try {
        const { keyId } = parseFieldEnvelope(value)
        atRestKey = await resolveWorkbuddyAtRestKey(keyId)
      } catch (error) {
        throw new WorkbuddyAccountError(
          `WorkBuddy 本机登录态里的 ${label} 是加密字段（${path}），但解不开：` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    try {
      return openFieldString(value, atRestKey).trim()
    } catch (error) {
      throw new WorkbuddyAccountError(
        `WorkBuddy 本机登录态里的 ${label} 解密失败（${path}）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  // 展示用字段：解不开不影响中转，不能连累 token。
  const decodeOptional = async (value: unknown) => {
    try {
      return await decode(value, "展示字段")
    } catch {
      return ""
    }
  }

  const accessToken = await decode(auth.accessToken, "auth.accessToken")
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
    refreshToken: await decode(auth.refreshToken, "auth.refreshToken"),
    expiresAt,
    domain: asString(auth.domain),
    uid: asString(account.uid),
    nickname: await decodeOptional(account.nickname),
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
