import assert from "node:assert/strict"
import { describe, it } from "node:test"

const { localOnlyGuard, localOnlyUnsupportedResponse } =
  require("./access-guard") as typeof import("./access-guard")

/**
 * `CODEX_HOT_SWITCH_SERVER_UI` 是模块级环境判断，这里用进程内切换覆盖两种部署形态。
 * 关注点只有一个：服务器部署必须挡住本机专属接口，本机壳模式必须完全放行。
 */
describe("localOnlyGuard", () => {
  it("服务器模式返回 501，并说明是本机专属能力", async () => {
    const previous = process.env.CODEX_HOT_SWITCH_SERVER_UI
    process.env.CODEX_HOT_SWITCH_SERVER_UI = "1"
    try {
      const response = await localOnlyGuard()
      assert.ok(response instanceof Response, "服务器模式必须返回响应而不是 null")
      assert.equal(response!.status, 501)
      const body = (await response!.json()) as {
        error: { message: string; type: string }
      }
      assert.equal(body.error.type, "not_implemented")
      assert.match(body.error.message, /本机/)
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOT_SWITCH_SERVER_UI
      else process.env.CODEX_HOT_SWITCH_SERVER_UI = previous
    }
  })

  it("本机模式返回 null，不拦截", () => {
    const previous = process.env.CODEX_HOT_SWITCH_SERVER_UI
    delete process.env.CODEX_HOT_SWITCH_SERVER_UI
    try {
      assert.equal(localOnlyGuard(), null)
    } finally {
      if (previous !== undefined) process.env.CODEX_HOT_SWITCH_SERVER_UI = previous
    }
  })

  it("拒绝响应带 no-store，避免被中间层缓存", () => {
    const response = localOnlyUnsupportedResponse()
    assert.equal(response.headers.get("cache-control"), "no-store")
  })
})

