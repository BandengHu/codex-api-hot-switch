import "server-only"

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  accountDataDirPath,
  findAccountById,
  normalizeUsername,
  type AccountRecord,
  type PublicAccount,
  toPublicAccount,
} from "./accounts-store"
import { resolveDataDir } from "./data-root"

/**
 * 每个账号自己的访问凭证。
 *
 * - API Key 只保存 scrypt 哈希，用于 `/v1` 与 `/api` 的客户端调用；
 * - 网页登录使用 HMAC 签名 Cookie，24 小时有效，只用于控制台与设置。
 *
 * 文件落在各账号自己的数据目录，天然隔离，不会被别的账号读到。
 */

export const ACCESS_COOKIE_NAME = "switchgate_session"
export const ACCESS_SESSION_TTL_SECONDS = 24 * 60 * 60

interface AccountAuthFile {
  version: 1
  keySalt: string
  keyHash: string
  /** API Key 的 AES-256-GCM 密文，用于控制台回显；校验仍以 keyHash 为准。 */
  keyCipher?: string
  sessionSecret: string
  createdAt: string
  updatedAt: string
}

export interface AccessSession {
  expiresAt: number
  accountId: string
}

export function accountAuthFilePath(dataDir = resolveDataDir()) {
  return join(dataDir, "access-auth.json")
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url")
}

export function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 32).toString("hex")
}

export function passwordSalt() {
  return randomBytes(16).toString("hex")
}

export function verifyPassword(password: string, salt: string, expectedHash: string) {
  const expected = Buffer.from(expectedHash, "hex")
  const actual = Buffer.from(hashPassword(password, salt), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function hashApiKey(apiKey: string, salt: string) {
  return scryptSync(apiKey, salt, 32).toString("hex")
}

/**
 * 密钥回显用的加密钥。
 *
 * 优先用部署方提供的 SWITCHGATE_SECRET_KEY；没有时退回 sessionSecret，
 * 保证单机部署开箱可用。两把钥都只存在于本账号目录内的 600 权限文件。
 */
function keyEncryptionSecret(file: AccountAuthFile) {
  return (
    process.env.SWITCHGATE_SECRET_KEY?.trim() ||
    file.sessionSecret
  )
}

function encryptApiKey(apiKey: string, file: AccountAuthFile) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(
    "aes-256-gcm",
    createHash("sha256").update(keyEncryptionSecret(file)).digest(),
    iv,
  )
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()])
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".")
}

function decryptApiKey(payload: string, file: AccountAuthFile) {
  const [rawIv, rawTag, rawData] = payload.split(".")
  if (!rawIv || !rawTag || !rawData) return null
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(keyEncryptionSecret(file)).digest(),
      Buffer.from(rawIv, "base64url"),
    )
    decipher.setAuthTag(Buffer.from(rawTag, "base64url"))
    return Buffer.concat([
      decipher.update(Buffer.from(rawData, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    return null
  }
}

async function readAuthFile(dataDir: string): Promise<AccountAuthFile | null> {
  try {
    const raw = await readFile(accountAuthFilePath(dataDir), "utf8")
    const parsed = JSON.parse(raw) as AccountAuthFile
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

async function writeAuthFile(dataDir: string, file: AccountAuthFile) {
  const path = accountAuthFilePath(dataDir)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(tempPath, path)
}

/** 账号首次启用时生成 Key；已有配置时绝不覆盖。 */
export async function ensureAccountAuth(dataDir: string): Promise<{ created: boolean; apiKey?: string }> {
  const existing = await readAuthFile(dataDir)
  if (existing) return { created: false }

  const apiKey = `sg_${randomBytes(24).toString("base64url")}`
  const keySalt = randomBytes(16).toString("hex")
  const now = new Date().toISOString()
  const file: AccountAuthFile = {
    version: 1,
    keySalt,
    keyHash: hashApiKey(apiKey, keySalt),
    keyCipher: "",
    sessionSecret: randomBytes(32).toString("base64url"),
    createdAt: now,
    updatedAt: now,
  }
  file.keyCipher = encryptApiKey(apiKey, file)
  await writeAuthFile(dataDir, file)
  return { created: true, apiKey }
}

/**
 * 读取本账号当前的 API Key 明文，供控制台展示与复制。
 *
 * 历史账号只存了 scrypt 哈希，没存密文，无法反推出原值；
 * 这种情况返回 null，由调用方引导用户显式更换一次。
 */
export async function readAccountApiKey(dataDir: string): Promise<string | null> {
  const file = await readAuthFile(dataDir)
  if (!file?.keyCipher) return null
  const apiKey = decryptApiKey(file.keyCipher, file)
  if (!apiKey) return null
  //密文与哈希必须指向同一把 Key，否则说明文件被改过，不返回。
  const expected = Buffer.from(file.keyHash, "hex")
  const actual = Buffer.from(hashApiKey(apiKey, file.keySalt), "hex")
  if (expected.length !== actual.length) return null
  return timingSafeEqual(expected, actual) ? apiKey : null
}

/**
 * 给历史账号补写密文。
 *
 * 只有调用方已经拿到明文（例如审批时下发的那一次）才能补；
 * 因此这个函数不会凭空生成新 Key，不影响正在使用的调用方。
 */
export async function rememberAccountApiKey(dataDir: string, apiKey: string) {
  const file = await readAuthFile(dataDir)
  if (!file || file.keyCipher) return
  const expected = Buffer.from(file.keyHash, "hex")
  const actual = Buffer.from(hashApiKey(apiKey, file.keySalt), "hex")
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return
  await writeAuthFile(dataDir, {
    ...file,
    keyCipher: encryptApiKey(apiKey, file),
    updatedAt: new Date().toISOString(),
  })
}

export async function verifyAccountApiKey(dataDir: string, apiKey: string): Promise<boolean> {
  const file = await readAuthFile(dataDir)
  if (!file || !apiKey.trim()) return false
  const expected = Buffer.from(file.keyHash, "hex")
  const actual = Buffer.from(hashApiKey(apiKey.trim(), file.keySalt), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export async function rotateAccountApiKey(dataDir: string): Promise<string> {
  const existing = await readAuthFile(dataDir)
  const apiKey = `sg_${randomBytes(24).toString("base64url")}`
  const keySalt = randomBytes(16).toString("hex")
  const now = new Date().toISOString()
  const file: AccountAuthFile = {
    version: 1,
    keySalt,
    keyHash: hashApiKey(apiKey, keySalt),
    keyCipher: "",
    sessionSecret: existing?.sessionSecret ?? randomBytes(32).toString("base64url"),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  file.keyCipher = encryptApiKey(apiKey, file)
  await writeAuthFile(dataDir, file)
  return apiKey
}

function signSession(accountId: string, expiresAt: number, secret: string) {
  return createHmac("sha256", secret)
    .update(`switchgate-session:${accountId}:${expiresAt}`)
    .digest("base64url")
}

export async function issueSessionCookie(
  accountId: string,
  options: { secure?: boolean } = {},
) {
  const dataDir = accountDataDirPath(accountId)
  const file = await readAuthFile(dataDir)
  if (!file) throw new Error("账号尚未初始化访问密钥")
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_SESSION_TTL_SECONDS
  const token = `${accountId}.${expiresAt}.${signSession(accountId, expiresAt, file.sessionSecret)}`
  return {
    token,
    expiresAt,
    cookie: [
      `${ACCESS_COOKIE_NAME}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      ...(options.secure ? ["Secure"] : []),
      `Max-Age=${ACCESS_SESSION_TTL_SECONDS}`,
    ].join("; "),
  }
}

export async function readSessionCookie(
  cookieHeader: string | null,
): Promise<AccessSession | null> {
  if (!cookieHeader) return null
  const value = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${ACCESS_COOKIE_NAME}=`))
    ?.slice(ACCESS_COOKIE_NAME.length + 1)
  if (!value) return null

  const [accountId, rawExpiresAt, signature] = value.split(".")
  const expiresAt = Number(rawExpiresAt)
  if (!accountId || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return null
  }
  if (!signature) return null

  const account = await findAccountById(accountId)
  if (!account || account.status !== "active") return null

  const file = await readAuthFile(accountDataDirPath(accountId))
  if (!file) return null
  const expected = Buffer.from(signSession(accountId, expiresAt, file.sessionSecret))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return { expiresAt, accountId }
}

export async function accessAuthStatus(dataDir = resolveDataDir()) {
  const file = await readAuthFile(dataDir)
  return {
    configured: Boolean(file),
    updatedAt: file?.updatedAt ?? "",
    sessionTtlSeconds: ACCESS_SESSION_TTL_SECONDS,
  }
}

export function clearSessionCookie(options: { secure?: boolean } = {}) {
  return [
    `${ACCESS_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
    "Max-Age=0",
  ].join("; ")
}

export function isSecureRequest(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto")
  if (forwardedProto) {
    return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https"
  }
  return new URL(request.url).protocol === "https:"
}

export function sessionAccountView(account: AccountRecord): PublicAccount {
  return toPublicAccount(account)
}

export { normalizeUsername }
