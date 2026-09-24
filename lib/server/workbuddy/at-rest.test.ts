import assert from "node:assert/strict"
import { createCipheriv, randomBytes } from "node:crypto"
import test from "node:test"

import {
  buildFieldAad,
  isEncryptedFieldWrapper,
  normalizeAtRestSecret,
  openFieldString,
  parseAtRestKeyPayload,
  WorkbuddyAtRestError,
} from "./at-rest-core"

const TEST_SECRET = Buffer.alloc(32, 7).toString("base64")
const TEST_KEY = normalizeAtRestSecret(TEST_SECRET)

/** 按 WorkBuddy 的信封格式封一个字段，用来验证解密侧。 */
function sealField(plaintext: string, keyId: string, key: Buffer) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 })
  cipher.setAAD(buildFieldAad(keyId, 1))
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()])
  const envelope = {
    suite: 1,
    keyId,
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  }
  return {
    $wbEncrypted: 1 as const,
    envelope: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
  }
}

test("sym-v1 field 的 AAD 与桌面端逐字节一致", () => {
  assert.equal(
    buildFieldAad("9127dea1b44020a7", 1).toString("hex"),
    "57422d41414400010000000557424556310000000673796d2d7631000000010000001039313237646561316234343032306137020000",
  )
})

test("静态钥信封解密还原明文", () => {
  const wrapper = sealField("eyJhbGciOiJIUzI1NiJ9.token", TEST_KEY.keyId, TEST_KEY.key)
  assert.equal(isEncryptedFieldWrapper(wrapper), true)
  assert.equal(openFieldString(wrapper, TEST_KEY), "eyJhbGciOiJIUzI1NiJ9.token")
})

test("keyId 与密钥不一致时明确报错，不静默返回空", () => {
  const wrapper = sealField("secret", TEST_KEY.keyId, TEST_KEY.key)
  const other = normalizeAtRestSecret(Buffer.alloc(32, 9).toString("base64"))
  assert.throws(() => openFieldString(wrapper, other), /密钥不匹配/)
})

test("明文串原样返回（老版本或未启用加密的机器）", () => {
  assert.equal(openFieldString("plain-token", TEST_KEY), "plain-token")
})

test("asym-v1 信封给出专门错误，不误报成登录失效", () => {
  const wrapper = { $wbEncrypted: 1 as const, scheme: "asym-v1", envelope: "e30=" }
  assert.throws(
    () => openFieldString(wrapper, TEST_KEY),
    (error: unknown) => error instanceof WorkbuddyAtRestError && /asym-v1/.test(error.message),
  )
})

test("密钥来料既支持密钥串也支持整份构建期 payload", () => {
  assert.equal(parseAtRestKeyPayload(TEST_SECRET), TEST_SECRET)
  assert.equal(
    parseAtRestKeyPayload(JSON.stringify({ version: 1, atRestSecretKey: TEST_SECRET })),
    TEST_SECRET,
  )
  assert.throws(() => normalizeAtRestSecret("not-base64"), /32 字节/)
  assert.throws(() => normalizeAtRestSecret(Buffer.alloc(16, 1).toString("base64")), /32 字节/)
})
