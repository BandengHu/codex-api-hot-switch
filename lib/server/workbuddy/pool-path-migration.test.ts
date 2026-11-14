import "server-only"

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

/**
 * 账号目录迁移后，号池仍必须能读到凭据。
 *
 * 旧实现把绝对路径写进 pool.json，目录一换就整天 ENOENT，
 * 签到调度直接静默失败——这里锁住「只按 uid 定位」这个不变量。
 */

async function withPoolDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "switchgate-pool-"))
  const dir = join(root, "workbuddy-pool")
  await mkdir(dir, { recursive: true })
  const previous = process.env.CODEX_HOT_SWITCH_DATA_DIR
  process.env.CODEX_HOT_SWITCH_DATA_DIR = root
  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOT_SWITCH_DATA_DIR
    else process.env.CODEX_HOT_SWITCH_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

const CREDENTIAL = JSON.stringify({
  auth: {
    accessToken: "token-1",
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 86_400_000,
  },
  account: { uid: "uid-1", nickname: "测试号" },
})

test("旧 pool.json 的过期绝对路径不会阻止读取凭据", async () => {
  await withPoolDir(async (dir) => {
    await writeFile(join(dir, "uid-1.json"), CREDENTIAL, "utf8")
    await writeFile(
      join(dir, "pool.json"),
      JSON.stringify({
        version: 1,
        entries: [
          {
            uid: "uid-1",
            nickname: "测试号",
            source: "file",
            filePath: "/opt/switchgate/data/workbuddy-pool/uid-1.json",
            disabled: false,
          },
        ],
      }),
      "utf8",
    )

    const { readPoolAccount, syncPoolFromDisk } = await import("./task-pool-store")
    const account = await readPoolAccount("uid-1")
    assert.equal(account.uid, "uid-1")

    // 旧字段会被就地纠正成文件名，不再保留迁移前的绝对路径。
    await syncPoolFromDisk()
    const state = JSON.parse(await readFile(join(dir, "pool.json"), "utf8"))
    assert.equal(state.entries[0].fileName, "uid-1.json")
    assert.equal(state.entries[0].filePath, undefined)
  })
})
