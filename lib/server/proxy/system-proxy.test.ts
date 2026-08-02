import { test } from "node:test"
import assert from "node:assert"
import {
  parseProxyServer,
  parseBypassList,
  shouldBypassProxy,
} from "./system-proxy-settings"

test("parseProxyServer handles bare host:port", () => {
  assert.strictEqual(parseProxyServer("127.0.0.1:7897"), "http://127.0.0.1:7897")
  assert.strictEqual(parseProxyServer("proxy.example.com:8080"), "http://proxy.example.com:8080")
})

test("parseProxyServer prefers https segment in per-protocol list", () => {
  const raw = "http=127.0.0.1:7897;https=127.0.0.1:7897"
  assert.strictEqual(parseProxyServer(raw), "http://127.0.0.1:7897")
})

test("parseProxyServer rejects garbage", () => {
  assert.strictEqual(parseProxyServer(null), null)
  assert.strictEqual(parseProxyServer("   "), null)
  assert.strictEqual(parseProxyServer("http://[invalid"), null)
})

test("parseBypassList drops <...> tokens", () => {
  assert.deepStrictEqual(
    parseBypassList("<local>;127.0.0.1;localhost;*.example.com"),
    ["127.0.0.1", "localhost", "*.example.com"],
  )
})

test("shouldBypassProxy matches host and wildcard", () => {
  const settings = {
    enabled: true,
    proxyUrl: "http://127.0.0.1:7897",
    bypassList: ["localhost", "*.example.com", "internal.corp"],
  }
  assert.ok(shouldBypassProxy("http://localhost:8787", settings))
  assert.ok(shouldBypassProxy("https://api.example.com", settings))
  assert.ok(shouldBypassProxy("https://internal.corp/x", settings))
  assert.ok(!shouldBypassProxy("https://bizdecipher.com/v1/chat", settings))
})