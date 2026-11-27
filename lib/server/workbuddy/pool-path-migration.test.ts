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

test("登录态失效会持久化，拒绝使用，并在重新导入同一账号后清除", async () => {
  await withPoolDir(async (dir) => {
    const credentials = JSON.stringify({
      auth: {
        accessToken: "token-2",
        refreshToken: "refresh-2",
        expiresAt: Date.now() + 86_400_000,
      },
      account: { uid: "uid-2", nickname: "待恢复号" },
    })
    await writeFile(join(dir, "uid-2.json"), credentials, "utf8")
    await writeFile(
      join(dir, "pool.json"),
      JSON.stringify({
        version: 1,
        activeUid: "uid-2",
        entries: [
          {
            uid: "uid-2",
            nickname: "待恢复号",
            source: "file",
            disabled: false,
          },
        ],
      }),
      "utf8",
    )

    const {
      importPoolAccount,
      markPoolAccountCredentialFailure,
      readPoolAccount,
      readPoolState,
      setActivePoolAccount,
    } = await import("./task-pool-store")
    await markPoolAccountCredentialFailure("uid-2", {
      code: 12153,
      message: "refresh token revoked",
      detectedAt: "2026-11-27T08:00:00.000Z",
    })

    const failedState = await readPoolState()
    assert.equal(failedState.activeUid, undefined)
    assert.equal(failedState.credentialFailures?.["uid-2"]?.code, 12153)
    await assert.rejects(() => readPoolAccount("uid-2"), /登录态已失效/)
    await assert.rejects(
      () => setActivePoolAccount("uid-2"),
      /登录态已失效/,
    )

    await importPoolAccount(credentials)
    const restoredState = await readPoolState()
    assert.equal(restoredState.credentialFailures?.["uid-2"], undefined)
    assert.equal((await readPoolAccount("uid-2")).uid, "uid-2")
  })
})

function renewableCredential(uid: string) {
  return JSON.stringify({
    auth: {
      accessToken: `access-${uid}`,
      refreshToken: `refresh-${uid}`,
      expiresAt: Date.now() + 86_400_000,
    },
    account: { uid, nickname: uid },
  })
}

async function writeSingleAccountPool(dir: string, uid: string) {
  await writeFile(join(dir, `${uid}.json`), renewableCredential(uid), "utf8")
  await writeFile(
    join(dir, "pool.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          uid,
          nickname: uid,
          source: "file",
          disabled: false,
        },
      ],
    }),
    "utf8",
  )
}

test("refreshToken 被撤销时持久记录登录态失效，普通网络错误仍使用未过期 token", async () => {
  await withPoolDir(async (dir) => {
    const { setProviderFetchForTesting } = await import(
      "@/lib/server/proxy/provider-fetch"
    )
    const { resetRenewalStateForTesting } = await import("./cn-token-renewal")
    const { readPoolAccount, readPoolState } = await import("./task-pool-store")
    resetRenewalStateForTesting()

    await writeSingleAccountPool(dir, "uid-revoked")
    const previous = setProviderFetchForTesting(async () =>
      Response.json(
        {
          code: 12153,
          msg: "12153:refresh token failed:idsvc token: invalid_grant: refresh token revoked (http 401)",
        },
        { status: 401 },
      ),
    )
    try {
      await assert.rejects(
        () => readPoolAccount("uid-revoked"),
        (error) => {
          assert.ok(error instanceof Error)
          assert.match(error.message, /登录态已失效/)
          assert.match(error.message, /refresh token revoked/)
          return true
        },
      )
      const state = await readPoolState()
      assert.equal(state.credentialFailures?.["uid-revoked"]?.code, 12153)
    } finally {
      setProviderFetchForTesting(previous)
    }

    await writeSingleAccountPool(dir, "uid-network")
    const networkPrevious = setProviderFetchForTesting(async () => {
      throw new Error("network temporarily unavailable")
    })
    try {
      const account = await readPoolAccount("uid-network")
      assert.equal(account.accessToken, "access-uid-network")
      assert.equal(
        (await readPoolState()).credentialFailures?.["uid-network"],
        undefined,
      )
    } finally {
      setProviderFetchForTesting(networkPrevious)
      resetRenewalStateForTesting()
    }
  })
})
