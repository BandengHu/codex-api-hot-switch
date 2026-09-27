import assert from "node:assert/strict"
import test from "node:test"
import { EndpointAttemptError } from "@/lib/server/provider-endpoint-runtime"
import { prepareUpstreamResponse } from "./upstream-response-primer"

function streamedResponse(chunks: string[], contentType?: string) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
        controller.close()
      },
    }),
    contentType ? { headers: { "content-type": contentType } } : undefined,
  )
}

test("buffered 2xx failure envelopes fail closed while successful JSON is replayed", async () => {
  await assert.rejects(
    () =>
      prepareUpstreamResponse(
        Response.json({
          status: "failed",
          error: { type: "server_error", message: "backend exploded" },
          output: [],
        }),
        false,
      ),
    (error) => {
      assert.ok(error instanceof EndpointAttemptError)
      assert.equal(error.kind, "transient")
      assert.equal(error.status, 503)
      assert.match(error.message, /backend exploded/)
      return true
    },
  )

  const source = JSON.stringify({
    status: "completed",
    error: null,
    output: [{ type: "message" }],
  })
  const prepared = await prepareUpstreamResponse(
    new Response(source, { headers: { "content-type": "application/json" } }),
    false,
  )
  assert.equal(await prepared.text(), source)
})

test("buffered semantic failures preserve authentication and client-error categories", async () => {
  await assert.rejects(
    () =>
      prepareUpstreamResponse(
        Response.json({
          status: "failed",
          error: { type: "authentication_error", message: "invalid API key" },
        }),
        false,
      ),
    (error) => {
      assert.ok(error instanceof EndpointAttemptError)
      assert.equal(error.kind, "auth")
      assert.equal(error.status, 401)
      return true
    },
  )

  await assert.rejects(
    () =>
      prepareUpstreamResponse(
        Response.json({
          status: "failed",
          error: { type: "invalid_request_error", message: "unsupported parameter" },
        }),
        false,
      ),
    (error) => {
      assert.ok(error instanceof EndpointAttemptError)
      assert.equal(error.kind, "terminal")
      assert.equal(error.status, 400)
      return true
    },
  )
})

test("stream priming accepts missing SSE headers and rejects pre-output failures", async () => {
  const failed = streamedResponse([
    "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
    "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}}\n\n",
  ])
  await assert.rejects(
    () => prepareUpstreamResponse(failed, true),
    (error) => {
      assert.ok(error instanceof EndpointAttemptError)
      assert.equal(error.kind, "transient")
      assert.equal(error.status, 503)
      assert.match(error.message, /busy/)
      return true
    },
  )

  const wholeJsonFailure = streamedResponse([
    JSON.stringify({
      status: "cancelled",
      error: { message: "worker disappeared" },
      output: [],
    }),
  ])
  await assert.rejects(
    () => prepareUpstreamResponse(wholeJsonFailure, true),
    /worker disappeared/,
  )
})

test("stream priming replays exact bytes and does not intercept failures after output", async () => {
  const chunks = [
    "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"好\"}\n\n",
    "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"late failure\"}}}\n\n",
  ]
  const prepared = await prepareUpstreamResponse(
    streamedResponse(chunks, "text/event-stream"),
    true,
  )
  assert.equal(await prepared.text(), chunks.join(""))
})

test("stream priming rejects empty bodies, times out, and preserves client cancellation", async () => {
  await assert.rejects(
    () => prepareUpstreamResponse(new Response(null), true),
    /响应体为空/,
  )

  const waiting = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined)
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )

  await assert.rejects(
    () => prepareUpstreamResponse(waiting(), true, { timeoutMs: 20 }),
    /首个有效输出前超时/,
  )

  const controller = new AbortController()
  const pending = prepareUpstreamResponse(waiting(), true, {
    requestSignal: controller.signal,
    timeoutMs: 1000,
  })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(pending, /客户端已取消/)
})
