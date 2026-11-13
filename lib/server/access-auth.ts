import "server-only"

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hotSwitchDataDir } from "./state-store"

/**
 * 远程 SwitchGate 的访问凭证。
 *
 * API Key 只保存 scrypt 哈希；网页登录使用独立的 HMAC 签名 Cookie，
 * 有效期固定 24 小时。配置文件与状态快照分开，避免被控制台导出。
 */

export const ACCESS_COOKIE_NAME = "switchgate_session"
export const ACCESS_SESSION_TTL_SECONDS = 24 * 60 * 60

interface AccessAuthFile {
  version: 1
  keySalt: string
  keyHash: string
  sessionSecret: string
  createdAt: string
  updatedAt: string
}

export interface AccessSession {
  expiresAt: number
}

function authFilePath() {
  return join(hotSwitchDataDir(), "access-auth.json")
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url")
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8")
}

function hashApiKey(apiKey: string, salt: string) {
  return scryptSync(apiKey, salt, 32).toString("hex")
}

async function readAuthFile(): Promise<AccessAuthFile | null> {
  try {
    const raw = await readFile(authFilePath(), "utf8")
    const parsed = JSON.parse(raw) as AccessAuthFile
    if (
      parsed.version !== 1 ||
      typeof parsed.keySalt !== "string" ||
      typeof parsed.keyHash !== "string" ||
      typeof parsed.sessionSecret !== "string"
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function writeAuthFile(file: AccessAuthFile) {
  const path = authFilePath()
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(tempPath, path)
}

/** 首次部署时生成 Key；已有配置时绝不覆盖。 */
export async function ensureAccessAuth(): Promise<{ created: boolean; apiKey?: string }> {
  const existing = await readAuthFile()
  if (existing) return { created: false }

  const apiKey = `sg_${randomBytes(24).toString("base64url")}`
  const keySalt = randomBytes(16).toString("hex")
  const now = new Date().toISOString()
  await writeAuthFile({
    version: 1,
    keySalt,
    keyHash: hashApiKey(apiKey, keySalt),
    sessionSecret: randomBytes(32).toString("base64url"),
    createdAt: now,
    updatedAt: now,
  })
  return { created: true, apiKey }
}

export async function verifyApiKey(apiKey: string): Promise<boolean> {
  const file = await readAuthFile()
  if (!file || !apiKey.trim()) return false
  const expected = Buffer.from(file.keyHash, "hex")
  const actual = Buffer.from(hashApiKey(apiKey.trim(), file.keySalt), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export async function rotateApiKey(): Promise<string> {
  const existing = await readAuthFile()
  const apiKey = `sg_${randomBytes(24).toString("base64url")}`
  const keySalt = randomBytes(16).toString("hex")
  const now = new Date().toISOString()
  await writeAuthFile({
    version: 1,
    keySalt,
    keyHash: hashApiKey(apiKey, keySalt),
    sessionSecret: existing?.sessionSecret ?? randomBytes(32).toString("base64url"),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  return apiKey
}

function signSession(expiresAt: number, secret: string) {
  return createHmac("sha256", secret)
    .update(`switchgate-session:${expiresAt}`)
    .digest("base64url")
}

export async function issueSessionCookie() {
  const file = await readAuthFile()
  if (!file) throw new Error("服务器尚未初始化访问密钥")
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_SESSION_TTL_SECONDS
  const token = `${expiresAt}.${signSession(expiresAt, file.sessionSecret)}`
  return {
    token,
    expiresAt,
    cookie: [
      `${ACCESS_COOKIE_NAME}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${ACCESS_SESSION_TTL_SECONDS}`,
    ].join("; "),
  }
}

export async function readSessionCookie(cookieHeader: string | null): Promise<AccessSession | null> {
  if (!cookieHeader) return null
  const value = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${ACCESS_COOKIE_NAME}=`))
    ?.slice(ACCESS_COOKIE_NAME.length + 1)
  if (!value) return null

  const [rawExpiresAt, signature] = value.split(".")
  const expiresAt = Number(rawExpiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000) || !signature) {
    return null
  }
  const file = await readAuthFile()
  if (!file) return null
  const expected = Buffer.from(signSession(expiresAt, file.sessionSecret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return { expiresAt }
}

export async function accessAuthStatus() {
  const file = await readAuthFile()
  return {
    configured: Boolean(file),
    updatedAt: file?.updatedAt ?? "",
    sessionTtlSeconds: ACCESS_SESSION_TTL_SECONDS,
  }
}

export function clearSessionCookie() {
  return `${ACCESS_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

