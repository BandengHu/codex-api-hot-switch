import assert from "node:assert/strict"
import { test } from "node:test"
import { resolvePublicBaseUrl } from "./public-base-url"

test("显式配置优先", () => {
  assert.equal(
    resolvePublicBaseUrl({
      configured: "https://switch.ztsnss.cloud/",
      proto: "http",
      host: "internal:54141",
    }),
    "https://switch.ztsnss.cloud",
  )
})

test("没有显式配置时按代理传入的原始协议与主机推导", () => {
  assert.equal(
    resolvePublicBaseUrl({ proto: "https", host: "switch.ztsnss.cloud" }),
    "https://switch.ztsnss.cloud",
  )
})

test("直接访问内部端口时回退为 http，避免伪造 https", () => {
  assert.equal(
    resolvePublicBaseUrl({ proto: null, host: "127.0.0.1:54141" }),
    "http://127.0.0.1:54141",
  )
})
