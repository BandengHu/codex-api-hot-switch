import assert from "node:assert/strict"
import { test } from "node:test"
import { formatPublicEndpoint } from "./public-endpoint"

test("服务器模式使用公网 HTTPS 入口，不暴露内部监听端口", () => {
  assert.equal(
    formatPublicEndpoint({
      publicBaseUrl: "https://switch.ztsnss.cloud",
      listenAddress: "0.0.0.0",
      port: 54140,
    }),
    "https://switch.ztsnss.cloud/v1",
  )
})

test("本机模式仍用监听地址拼本地中转地址", () => {
  assert.equal(
    formatPublicEndpoint({
      listenAddress: "127.0.0.1",
      port: 8787,
    }),
    "http://127.0.0.1:8787/v1",
  )
})

test("公网入口末尾多余的斜杠会被去掉", () => {
  assert.equal(
    formatPublicEndpoint({
      publicBaseUrl: "https://switch.ztsnss.cloud/",
      listenAddress: "0.0.0.0",
      port: 54141,
    }),
    "https://switch.ztsnss.cloud/v1",
  )
})
