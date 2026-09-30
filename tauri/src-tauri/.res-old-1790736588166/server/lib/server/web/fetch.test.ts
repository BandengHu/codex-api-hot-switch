import assert from "node:assert/strict"
import test from "node:test"
import { buildWebFetchInit, webRequestUrl } from "./fetch"

test("web fetch keeps the request URL and init when no proxy is needed", () => {
  const init = {
    method: "POST",
    headers: { accept: "application/json" },
    body: "{}",
  }
  assert.equal(webRequestUrl("https://example.com/search"), "https://example.com/search")
  assert.deepEqual(buildWebFetchInit(init, undefined), init)
})

test("web fetch adds the system proxy dispatcher without dropping request fields", () => {
  const dispatcher = { dispatch() {} }
  const init = {
    method: "POST",
    headers: { accept: "application/json" },
    body: "{}",
    signal: new AbortController().signal,
  }
  const result = buildWebFetchInit(init, dispatcher)
  assert.equal(result.dispatcher, dispatcher)
  assert.equal(result.method, "POST")
  assert.deepEqual(result.headers, { accept: "application/json" })
  assert.equal(result.body, "{}")
  assert.ok(result.signal)
})
