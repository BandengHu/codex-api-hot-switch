import "server-only"

import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"

import { fetchProvider } from "./provider-fetch"

test("供应商请求不依赖被包装的 globalThis.fetch", async (t) => {
  const server = createServer((_request, response) => {
    response.setHeader("connection", "close")
    response.end("provider-ok")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  )

  const address = server.address()
  assert.ok(address && typeof address === "object")

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("globalThis.fetch 不应被供应商请求调用")
  }
  try {
    const response = await fetchProvider(
      `http://127.0.0.1:${address.port}/provider-health`,
    )
    assert.equal(response.status, 200)
    assert.equal(await response.text(), "provider-ok")
  } finally {
    globalThis.fetch = originalFetch
  }
})
