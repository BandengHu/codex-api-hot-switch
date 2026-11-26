import "server-only"

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/**
 * 临时访问密钥：给账号签发一把有期限的额外 Key，到期自动失效。
 *
 * 与主 Key（access-auth.json）完全分开存放，是刻意的设计：
 * 主 Key 一个字段都不改，因此签发、过期、撤销临时 Key 都不会让正在用的主 Key 失效。
 * 校验只存 scrypt 哈希，文件里没有可比对的原值，泄露文件也无法还原密钥。
 *
 * 过期不是靠定时任务删记录，而是校验时比对 expiresAt；
 * 所以服务重启、任务没跑，都不会让过期时间失效或延长。
 */

export interface TempKeyRecord {
  /** 便于区分是哪一把，日志里也只出现这个。 */
  id: string
  /** 给使用者看的备注，例如「小程序测试」。 */
  label: string
  keySalt: string
  keyHash: string
  createdAt: string
  expiresAt: string
}

interface TempKeysFile {
  version: 1
  keys: TempKeyRecord[]
}

export const TEMP_KEYS_FILE = "temp-keys.json"

export function tempKeysFilePath(dataDir: string) {
  return join(dataDir, TEMP_KEYS_FILE)
}

function hashTempKey(apiKey: string, salt: string) {
  return scryptSync(apiKey, salt, 32).toString("hex")
}

async function readTempKeysFile(dataDir: string): Promise<TempKeysFile> {
  try {
    const raw = await readFile(tempKeysFilePath(dataDir), "utf8")
    const parsed = JSON.parse(raw) as Partial<TempKeysFile>
    if (parsed.version !== 1 || !Array.isArray(parsed.keys)) {
      return { version: 1, keys: [] }
    }
    const keys = parsed.keys.filter(
      (record): record is TempKeyRecord =>
        Boolean(record) &&
        typeof record.id === "string" &&
        typeof record.keySalt === "string" &&
        typeof record.keyHash === "string" &&
        typeof record.expiresAt === "string",
    )
    return { version: 1, keys }
  } catch {
    // 文件不存在或损坏都当作「没有临时 Key」，绝不因此阻断主 Key。
    return { version: 1, keys: [] }
  }
}

async function writeTempKeysFile(dataDir: string, file: TempKeysFile) {
  const path = tempKeysFilePath(dataDir)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(tempPath, path)
}

/** 明文只在这一个返回值里出现一次，不落盘、不打日志。 */
export async function issueTempKey(
  dataDir: string,
  options: { days: number; label?: string },
): Promise<{ apiKey: string; record: TempKeyRecord }> {
  const days = Math.trunc(options.days)
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    throw new Error("临时 Key 的有效期必须在 1 到 365 天之间")
  }
  const file = await readTempKeysFile(dataDir)
  const now = new Date()
  const apiKey = `sgt_${randomBytes(24).toString("base64url")}`
  const keySalt = randomBytes(16).toString("hex")
  const record: TempKeyRecord = {
    id: `tmp_${randomBytes(6).toString("hex")}`,
    label: (options.label ?? "").trim().slice(0, 60),
    keySalt,
    keyHash: hashTempKey(apiKey, keySalt),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
  }
  // 顺手清掉已过期的记录，避免文件无限增长；不影响仍在有效期内的。
  const keep = file.keys.filter((item) => Date.parse(item.expiresAt) > now.getTime())
  await writeTempKeysFile(dataDir, { version: 1, keys: [...keep, record] })
  return { apiKey, record }
}

/**
 * 校验一把 Key 是不是本账号未过期的临时 Key。
 *
 * 逐个比对，不提前返回位置；过期即视为不存在，不做任何宽限期。
 */
export async function verifyTempKey(dataDir: string, apiKey: string): Promise<boolean> {
  const value = apiKey.trim()
  if (!value) return false
  const file = await readTempKeysFile(dataDir)
  if (!file.keys.length) return false
  const now = Date.now()
  let matched = false
  for (const record of file.keys) {
    if (!(Date.parse(record.expiresAt) > now)) continue
    const expected = Buffer.from(record.keyHash, "hex")
    const actual = Buffer.from(hashTempKey(value, record.keySalt), "hex")
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) matched = true
  }
  return matched
}

/** 只读清单，用于控制台展示；不含任何可还原密钥的信息。 */
export async function listTempKeys(dataDir: string): Promise<Array<Omit<TempKeyRecord, "keySalt" | "keyHash">>> {
  const file = await readTempKeysFile(dataDir)
  const now = Date.now()
  return file.keys
    .filter((record) => Date.parse(record.expiresAt) > now)
    .map(({ id, label, createdAt, expiresAt }) => ({ id, label, createdAt, expiresAt }))
}

/** 撤销一把临时 Key；返回是否真的删掉了。 */
export async function revokeTempKey(dataDir: string, id: string): Promise<boolean> {
  const file = await readTempKeysFile(dataDir)
  const next = file.keys.filter((record) => record.id !== id)
  if (next.length === file.keys.length) return false
  await writeTempKeysFile(dataDir, { version: 1, keys: next })
  return true
}

/** 日志里只放指纹，便于判断「是不是同一把」，无法还原。 */
export function tempKeyFingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 8)
}
