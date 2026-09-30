import assert from "node:assert/strict"
import test from "node:test"

import {
  fetchWithHtmlResponseRetry,
  htmlUpstreamErrorMessage,
  HTML_RESPONSE_MAX_RETRIES,
  looksLikeHtmlDocument,
} from "./html-response-retry"

const htmlError = `<!DOCTYPE html>
<html lang="zh-CN">
  <head><title>502 Bad Gateway</title></head>
  <body>gateway error</body>
</html>`

test("retries an HTML gateway error until the upstream succeeds", async () => {
  let calls = 0
  const result = await fetchWithHtmlResponseRetry({
    fetchResponse: async () => {
      calls += 1
      if (calls === 1) {
        return new Response(htmlError, {
          status: 502,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      return new Response("event: response.completed\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    },
  })

  assert.equal(calls, 2)
  assert.equal(result.retryCount, 1)
  assert.equal(result.response.status, 200)
})

test("stops after the HTML retry limit and preserves the final response", async () => {
  let calls = 0
  const result = await fetchWithHtmlResponseRetry({
    fetchResponse: async () => {
      calls += 1
      return new Response(htmlError, {
        status: 502,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    },
  })

  assert.equal(calls, HTML_RESPONSE_MAX_RETRIES + 1)
  assert.equal(result.retryCount, HTML_RESPONSE_MAX_RETRIES)
  assert.equal(result.response.status, 502)
  assert.match(await result.response.text(), /502 Bad Gateway/)
})

test("does not retry a structured JSON upstream error", async () => {
  let calls = 0
  const result = await fetchWithHtmlResponseRetry({
    fetchResponse: async () => {
      calls += 1
      return new Response(
        JSON.stringify({ error: { message: "invalid request", type: "invalid_request_error" } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    },
  })

  assert.equal(calls, 1)
  assert.equal(result.retryCount, 0)
  assert.equal(result.response.status, 400)
})

test("recognizes HTML and returns a concise final gateway error", () => {
  assert.equal(looksLikeHtmlDocument(htmlError), true)
  assert.equal(looksLikeHtmlDocument('{"error":"bad gateway"}'), false)
  assert.equal(
    htmlUpstreamErrorMessage(502),
    "上游返回 HTTP 502 Bad Gateway（HTML 错误页）",
  )
  assert.doesNotMatch(htmlUpstreamErrorMessage(502), /<!DOCTYPE|<html/i)
})
