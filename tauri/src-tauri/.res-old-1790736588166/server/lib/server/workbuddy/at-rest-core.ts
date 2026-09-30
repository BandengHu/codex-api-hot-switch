import { createDecipheriv, createHash } from "node:crypto"

/**
 * WorkBuddy 桌面端 5.6.2 起的本机凭据加密（at-rest "fields" 策略）。
 *
 * 桌面端把 `auth.accessToken` / `auth.refreshToken` / `account.nickname` /
 * `account.phoneNumber` 从明文字符串换成标准信封：
 *
 * ```json
 * { "$wbEncrypted": 1, "envelope": "<base64 of {suite,keyId,nonce,authTag,ciphertext}>" }
 * ```
 *
 * 信封是 AES-256-GCM，AAD 由 keyId / scheme(sym-v1) / framing(field) 逐字段
 * 长度前缀拼出来，跟桌面端 `buildAuthenticatedContextAad()` 的实现逐字节对齐。
 * 用来解密的密钥是构建期塞进 native 的 `atRestSecretKey`：先按 UTF-8 取
 * sha256 得到 32 字节 AES 钥，keyId 再取该钥 sha256 的十六进制前 16 位——
 * 所以拿到候选密钥后可以先用信封里的 keyId 自校验，再真解密。
 *
 * 明文串直接返回：桌面端自己也这么读（`ProtectedFieldCodec.decodeString`），
 * 老版本或策略为 off 的机器上字段本来就是明文。
 *
 * 纯逻辑放 `-core`，`at-rest.ts` 只做 server-only 标记，测试直接引本文件。
 */

const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii")
/** sym-v1 的 field framing：格式标识 WBEV1、frame code 2。 */
const FIELD_FORMAT_ID = "WBEV1"
const FIELD_FRAMING_CODE = 2
const SCHEME = "sym-v1"
const SUITE = 1
const FIELD_NONCE_BYTES = 12
const FIELD_AUTH_TAG_BYTES = 16
const MASTER_KEY_BYTES = 32
const ENVELOPE_FIELDS = ["authTag", "ciphertext", "keyId", "nonce", "suite"]

export class WorkbuddyAtRestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkbuddyAtRestError"
  }
}

export interface WorkbuddyAtRestKey {
  /** 构建期 payload 里的 `atRestSecretKey`（44 字符标准 base64）。 */
  secret: string
  /** 真正参与 AES-256-GCM 的密钥：sha256(secret)。 */
  key: Buffer
  /** sha256(key) 的十六进制前 16 位，等于信封里的 keyId。 */
  keyId: string
}

export interface WorkbuddyFieldEnvelope {
  suite: number
  keyId: string
  nonce: Buffer
  authTag: Buffer
  ciphertext: Buffer
}

/** 加密字段信封：`$wbEncrypted: 1` + base64 envelope。 */
export function isEncryptedFieldWrapper(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.$wbEncrypted !== 1) return false
  return typeof value.envelope === "string" && value.envelope.length > 0
}

/** `asym-v1` 信封要 Tencent 的开发私钥才能开，本机解不开。 */
export function isAsymmetricFieldWrapper(value: unknown): boolean {
  return isEncryptedFieldWrapper(value) && isRecord(value) && value.scheme === "asym-v1"
}

export function parseFieldEnvelope(value: unknown): WorkbuddyFieldEnvelope {
  if (!isEncryptedFieldWrapper(value)) {
    throw new WorkbuddyAtRestError("加密字段信封结构不对：缺少 $wbEncrypted / envelope")
  }
  const wrapper = value as Record<string, unknown>
  const envelopeBytes = decodeCanonicalBase64(String(wrapper.envelope), "envelope")
  let payload: unknown
  try {
    payload = JSON.parse(envelopeBytes.toString("utf8"))
  } catch {
    throw new WorkbuddyAtRestError("加密字段信封不是合法 JSON")
  }
  if (!isRecord(payload)) throw new WorkbuddyAtRestError("加密字段信封不是对象")
  const keys = Object.keys(payload).sort()
  if (keys.length !== ENVELOPE_FIELDS.length || keys.some((key, index) => key !== ENVELOPE_FIELDS[index])) {
    throw new WorkbuddyAtRestError("加密字段信封的字段与 suite 1 结构不匹配")
  }
  const suite = payload.suite
  if (suite !== SUITE) {
    throw new WorkbuddyAtRestError(`不支持的加密套件 suite=${String(suite)}`)
  }
  const keyId = typeof payload.keyId === "string" ? payload.keyId : ""
  if (!/^[0-9a-f]{16}$/.test(keyId)) {
    throw new WorkbuddyAtRestError("加密字段信封的 keyId 不是 16 位小写十六进制")
  }
  const nonce = decodeCanonicalBase64(String(payload.nonce), "nonce")
  const authTag = decodeCanonicalBase64(String(payload.authTag), "authTag")
  const ciphertext = String(payload.ciphertext ?? "") === ""
    ? Buffer.alloc(0)
    : decodeCanonicalBase64(String(payload.ciphertext), "ciphertext")
  if (nonce.length !== FIELD_NONCE_BYTES || authTag.length !== FIELD_AUTH_TAG_BYTES) {
    throw new WorkbuddyAtRestError("加密字段信封的 nonce 或 authTag 长度不对")
  }
  return { suite, keyId, nonce, authTag, ciphertext }
}

/** 从 at-rest 密钥串（或整份构建期 payload JSON）里取出 `atRestSecretKey`。 */
export function parseAtRestKeyPayload(raw: string): string {
  const text = raw.trim()
  if (!text) throw new WorkbuddyAtRestError("at-rest 密钥为空")
  if (!text.startsWith("{")) return text
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new WorkbuddyAtRestError("at-rest 密钥 payload 不是合法 JSON")
  }
  if (!isRecord(payload)) throw new WorkbuddyAtRestError("at-rest 密钥 payload 不是对象")
  const secret = typeof payload.atRestSecretKey === "string" ? payload.atRestSecretKey.trim() : ""
  if (!secret) throw new WorkbuddyAtRestError("at-rest 密钥 payload 里没有 atRestSecretKey")
  return secret
}

export function normalizeAtRestSecret(secret: string): WorkbuddyAtRestKey {
  const value = secret.trim()
  const decoded = Buffer.from(value, "base64")
  if (decoded.length !== MASTER_KEY_BYTES || decoded.toString("base64") !== value) {
    throw new WorkbuddyAtRestError("atRestSecretKey 必须是 32 字节的标准 base64")
  }
  const key = createHash("sha256").update(value, "utf8").digest()
  return { secret: value, key, keyId: deriveAtRestKeyId(key) }
}

export function deriveAtRestKeyId(key: Buffer) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16)
}

/**
 * 打开一个 `$wbEncrypted` 字段。
 *
 * 普通字段传进来是字符串时原样返回；`asym-v1` 信封直接报错，别让上层把
 * "解不开" 误判成 "登录掉了"。
 */
export function openFieldString(value: unknown, key: WorkbuddyAtRestKey): string {
  if (typeof value === "string") return value
  if (isAsymmetricFieldWrapper(value)) {
    throw new WorkbuddyAtRestError(
      "该字段是 asym-v1（仅 Tencent 开发私钥可解）的加密信封，本机无法读取",
    )
  }
  const envelope = parseFieldEnvelope(value)
  if (envelope.keyId !== key.keyId) {
    throw new WorkbuddyAtRestError(
      `at-rest 密钥不匹配：信封 keyId=${envelope.keyId}，当前密钥 keyId=${key.keyId}`,
    )
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, envelope.nonce, {
      authTagLength: FIELD_AUTH_TAG_BYTES,
    })
    decipher.setAAD(buildFieldAad(envelope.keyId, envelope.suite))
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([
      decipher.update(envelope.ciphertext),
      decipher.final(),
    ]).toString("utf8")
  } catch (error) {
    throw new WorkbuddyAtRestError(
      `加密字段认证失败（keyId=${envelope.keyId}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * sym-v1 / framing=field 的 AAD，逐字节对齐桌面端
 * `buildAuthenticatedContextAad(keyId, suite, { framing: "field" }, "sym-v1")`。
 */
export function buildFieldAad(keyId: string, suite: number) {
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(FIELD_FORMAT_ID),
    encodeLengthPrefixed(SCHEME),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FIELD_FRAMING_CODE]),
    // 整值字段没有 sequence：encodeOptionalUint64(undefined) -> [0]
    Buffer.from([0]),
    // final 未传 -> [0]
    Buffer.from([0]),
  ])
}

function encodeUint32(value: number) {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}

function encodeLengthPrefixed(value: string) {
  const bytes = Buffer.from(value, "utf8")
  return Buffer.concat([encodeUint32(bytes.length), bytes])
}

function decodeCanonicalBase64(value: string, field: string) {
  if (!value) throw new WorkbuddyAtRestError(`加密字段信封的 ${field} 为空`)
  const decoded = Buffer.from(value, "base64")
  if (decoded.length === 0 || decoded.toString("base64") !== value) {
    throw new WorkbuddyAtRestError(`加密字段信封的 ${field} 不是标准 base64`)
  }
  return decoded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
