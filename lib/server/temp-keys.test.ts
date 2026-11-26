import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

const dataDir = mkdtempSync(join(tmpdir(), "switchgate-tempkeys-"))
process.env.CODEX_HOT_SWITCH_DATA_DIR = dataDir
process.env.CODEX_HOT_SWITCH_SERVER_UI = "1"

const {
  accountDataDirPath,
  createAccount,
  resetAccountsCacheForTests,
} = require("./accounts-store") as typeof import("./accounts-store")
const {
  ensureAccountAuth,
  hashPassword,
  passwordSalt,
  verifyAccountApiKey,
} = require("./account-auth") as typeof import("./account-auth")
const {
  issueTempKey,
  listTempKeys,
  revokeTempKey,
  tempKeysFilePath,
  verifyTempKey,
} = require("./temp-keys") as typeof import("./temp-keys")
const { accountFromApiKey } = require("./access-guard") as typeof import("./access-guard")

async function makeAccount(username: string) {
  const salt = passwordSalt()
  const account = await createAccount({
    username,
    role: "member",
    status: "active",
    passwordSalt: salt,
    passwordHash: hashPassword("test-password-123", salt),
  })
  const dir = accountDataDirPath(account.id)
  const auth = await ensureAccountAuth(dir)
  return { account, dir, apiKey: auth.apiKey as string }
}

describe("临时访问密钥", () => {
  let alice: Awaited<ReturnType<typeof makeAccount>>
  let bob: Awaited<ReturnType<typeof makeAccount>>

  before(async () => {
    alice = await makeAccount("tempa")
    bob = await makeAccount("tempb")
  })

  after(async () => {
    resetAccountsCacheForTests()
    await rm(dataDir, { recursive: true, force: true })
    delete process.env.CODEX_HOT_SWITCH_SERVER_UI
  })

  it("签发临时 Key 不会让主 Key 失效", async () => {
    assert.equal(await verifyAccountApiKey(alice.dir, alice.apiKey), true, "签发前主 Key 可用")

    const { apiKey, record } = await issueTempKey(alice.dir, { days: 7, label: "小程序" })
    assert.match(apiKey, /^sgt_/)
    assert.notEqual(apiKey, alice.apiKey)
    assert.equal(record.label, "小程序")

    // 这是本需求的核心：主 Key 必须仍然可用。
    assert.equal(await verifyAccountApiKey(alice.dir, alice.apiKey), true, "签发后主 Key 仍然可用")
    assert.equal(await verifyTempKey(alice.dir, apiKey), true, "临时 Key 同时可用")
  })

  it("临时 Key 能解析到所属账号，且不串号", async () => {
    const { apiKey } = await issueTempKey(bob.dir, { days: 7 })
    const context = await accountFromApiKey(new Headers({ "x-api-key": apiKey }))
    assert.equal(context?.account.id, bob.account.id)
    assert.equal(context?.dataDir, bob.dir)

    // 同一把临时 Key 放到另一个账号的目录下不成立。
    assert.equal(await verifyTempKey(alice.dir, apiKey), false)
  })

  it("主 Key 仍可解析（临时 Key 没有挤掉原来的通道）", async () => {
    const context = await accountFromApiKey(new Headers({ "x-api-key": alice.apiKey }))
    assert.equal(context?.account.id, alice.account.id)
  })

  it("过期后立即失效", async () => {
    const { record } = await issueTempKey(alice.dir, { days: 7 })
    const path = tempKeysFilePath(alice.dir)
    const file = JSON.parse(await readFile(path, "utf8"))
    const target = file.keys.find((item: { id: string }) => item.id === record.id)
    assert.ok(target, "记录应已写入")
    target.expiresAt = new Date(Date.now() - 1000).toISOString()
    await (
      await import("node:fs/promises")
    ).writeFile(path, JSON.stringify(file), "utf8")

    assert.equal(await verifyTempKey(alice.dir, "sgt_whatever"), false)
    // 过期的记录不再出现在清单里。
    const listed = await listTempKeys(alice.dir)
    assert.equal(
      listed.some((item) => item.id === record.id),
      false,
      "过期记录不应出现在清单中",
    )
  })

  it("撤销一把临时 Key 不影响其他 Key 和主 Key", async () => {
    const first = await issueTempKey(alice.dir, { days: 7, label: "第一把" })
    const second = await issueTempKey(alice.dir, { days: 7, label: "第二把" })

    assert.equal(await revokeTempKey(alice.dir, first.record.id), true)
    assert.equal(await verifyTempKey(alice.dir, first.apiKey), false, "已撤销的失效")
    assert.equal(await verifyTempKey(alice.dir, second.apiKey), true, "另一把仍然可用")
    assert.equal(await verifyAccountApiKey(alice.dir, alice.apiKey), true, "主 Key 依旧可用")
  })

  it("拒绝不合理有效期", async () => {
    await assert.rejects(() => issueTempKey(alice.dir, { days: 0 }))
    await assert.rejects(() => issueTempKey(alice.dir, { days: 400 }))
  })

  it("文件里没有可还原的明文", async () => {
    const { apiKey } = await issueTempKey(alice.dir, { days: 7 })
    const raw = await readFile(tempKeysFilePath(alice.dir), "utf8")
    assert.equal(raw.includes(apiKey), false, "文件里不能出现密钥明文")
    assert.equal(raw.includes(alice.apiKey), false, "文件里不能出现主 Key")
  })
})
