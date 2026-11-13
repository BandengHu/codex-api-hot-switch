import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

const dataDir = mkdtempSync(join(tmpdir(), "switchgate-accounts-"))
process.env.CODEX_HOT_SWITCH_DATA_DIR = dataDir
process.env.CODEX_HOT_SWITCH_SERVER_UI = "1"

const {
  accountDataDirPath,
  createAccount,
  findAccountByUsername,
  resetAccountsCacheForTests,
  updateAccount,
} = require("./accounts-store") as typeof import("./accounts-store")
const { ensureAccountAuth, hashPassword, passwordSalt, verifyAccountApiKey, verifyPassword } =
  require("./account-auth") as typeof import("./account-auth")
const { accountFromApiKey } = require("./access-guard") as typeof import("./access-guard")
const { runWithAccountDataDir } = require("./data-root") as typeof import("./data-root")
const { getSnapshot, saveSnapshot } =
  require("./state-store") as typeof import("./state-store")

async function makeAccount(username: string, role: "admin" | "member" = "member") {
  const salt = passwordSalt()
  const account = await createAccount({
    username,
    role,
    status: "active",
    passwordSalt: salt,
    passwordHash: hashPassword("test-password-123", salt),
  })
  const dataDirectory = accountDataDirPath(account.id)
  const auth = await ensureAccountAuth(dataDirectory)
  return { account, dataDir: dataDirectory, apiKey: auth.apiKey as string }
}

describe("账号隔离", () => {
  let alice: Awaited<ReturnType<typeof makeAccount>>
  let bob: Awaited<ReturnType<typeof makeAccount>>

  before(async () => {
    alice = await makeAccount("alice", "admin")
    bob = await makeAccount("bob")
  })

  after(async () => {
    resetAccountsCacheForTests()
    await rm(dataDir, { recursive: true, force: true })
    delete process.env.CODEX_HOT_SWITCH_SERVER_UI
  })

  it("用户名大小写归一，不能重复注册", async () => {
    await assert.rejects(
      makeAccount("ALICE"),
      /已被占用/,
      "同名账号必须被拒绝",
    )
    const found = await findAccountByUsername("Alice")
    assert.equal(found?.id, alice.account.id)
  })

  it("密码与 API Key 只匹配本账号", async () => {
    assert.equal(
      verifyPassword("test-password-123", alice.account.passwordSalt, alice.account.passwordHash),
      true,
    )
    assert.equal(
      verifyPassword("wrong-password", alice.account.passwordSalt, alice.account.passwordHash),
      false,
    )
    assert.equal(await verifyAccountApiKey(alice.dataDir, alice.apiKey), true)
    assert.equal(await verifyAccountApiKey(bob.dataDir, alice.apiKey), false)
  })

  it("API Key 能解析出所属账号与目录", async () => {
    const headers = new Headers({ "x-api-key": bob.apiKey })
    const context = await accountFromApiKey(headers)
    assert.equal(context?.account.id, bob.account.id)
    assert.equal(context?.dataDir, bob.dataDir)

    const missing = await accountFromApiKey(new Headers())
    assert.equal(missing, null)
  })

  it("两个账号的配置互相不可见", async () => {
    const aliceSnapshot = await runWithAccountDataDir(alice.dataDir, () => getSnapshot())
    const bobSnapshot = await runWithAccountDataDir(bob.dataDir, () => getSnapshot())

    // 演示账号本身也是空白起步，这里只断言两者是各自独立的快照。
    assert.equal(aliceSnapshot.providers.length, 0)
    assert.equal(bobSnapshot.providers.length, 0, "新账号必须是空白配置")

    const changed = {
      ...aliceSnapshot,
      settings: { ...aliceSnapshot.settings, logRetentionDays: 9 },
    }
    await runWithAccountDataDir(alice.dataDir, () => saveSnapshot(changed))

    const bobAfter = await runWithAccountDataDir(bob.dataDir, () => getSnapshot())
    const aliceAfter = await runWithAccountDataDir(alice.dataDir, () => getSnapshot())
    assert.equal(bobAfter.settings.logRetentionDays === 9, false)
    assert.equal(aliceAfter.settings.logRetentionDays, 9)
  })

  it("服务器模式缺少账号上下文时拒绝读共享目录", async () => {
    await assert.rejects(
      () => getSnapshot(),
      /缺少账号上下文/,
      "没有账号上下文绝不能回退到共享目录",
    )
  })

  it("停用账号后 Key 立即失效", async () => {
    await updateAccount(bob.account.id, { status: "disabled" })
    const context = await accountFromApiKey(new Headers({ "x-api-key": bob.apiKey }))
    assert.equal(context, null)
  })
})
