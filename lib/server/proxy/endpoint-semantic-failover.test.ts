import assert from "node:assert/strict"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import type { Provider } from "@/lib/types"
import type { ProxyTarget } from "./common"

const dataDir = join(
  tmpdir(),
  `switchgate-semantic-failover-test-${process.pid}-${Date.now()}`,
)
process.env.CODEX_HOT_SWITCH_DATA_DIR = dataDir

let fetchWithEndpointFailover: typeof import("./endpoint-failover").fetchWithEndpointFailover

test.before(async () => {
  await mkdir(dataDir, { recursive: true })
  fetchWithEndpointFailover = (
    await import("./endpoint-failover")
  ).fetchWithEndpointFailover
})

function provider(id: string): Provider {
  return {
    id,
    name: id,
    protocol: "openai-responses",
    endpoints: [
      {
        id: `${id}-primary`,
        name: "主用",
        baseUrl: `https://${id}.example/v1`,
        apiKey: `${id}-key-1`,
        enabled: true,
      },
      {
        id: `${id}-fallback`,
        name: "备用 1",
        baseUrl: "",
        apiKey: `${id}-key-2`,
        enabled: true,
      },
    ],
    headers: [],
    bodyOverride: "",
    timeoutMs: 1000,
    reasoningDialect: "auto",
    rawResponsesPassthrough: true,
    enabled: true,
    isDefault: false,
    health: "healthy",
  }
}

function target(value: Provider): ProxyTarget {
  return {
    provider: {
      ...value,
      baseUrl: value.endpoints[0].baseUrl,
      apiKey: value.endpoints[0].apiKey,
      activeEndpointId: value.endpoints[0].id,
      activeEndpointName: value.endpoints[0].name,
    },
    modelId: "test-model",
    requestedModel: "test-model",
    reasoning: "off",
    paused: false,
  }
}

function isPrimary(init: RequestInit | undefined, value: Provider) {
  return new Headers(init?.headers).get("authorization") ===
    `Bearer ${value.endpoints[0].apiKey}`
}

test("2xx failure envelopes count as transient failures and switch on the fourth request", async () => {
  const value = provider("semantic-json")
  const originalFetch = globalThis.fetch
  let primaryCalls = 0
  let fallbackCalls = 0
  globalThis.fetch = async (_input, init) => {
    if (isPrimary(init, value)) {
      primaryCalls += 1
      return Response.json({
        status: "failed",
        error: { type: "server_error", message: "backend exploded" },
        output: [],
      })
    }
    fallbackCalls += 1
    return Response.json({
      id: "resp-ok",
      status: "completed",
      error: null,
      output: [],
    })
  }

  try {
    for (let count = 1; count <= 3; count += 1) {
      const result = await fetchWithEndpointFailover({
        target: target(value),
        path: "v1/responses",
        body: { model: "test-model", input: "hello", stream: false },
        requestIsStream: false,
        capacityRetryEnabled: false,
      })
      assert.equal(result.response.status, 503)
      assert.deepEqual(result.target.attemptedEndpointIds, [value.endpoints[0].id])
      assert.match(await result.response.text(), /backend exploded/)
    }

    const fourth = await fetchWithEndpointFailover({
      target: target(value),
      path: "v1/responses",
      body: { model: "test-model", input: "hello", stream: false },
      requestIsStream: false,
      capacityRetryEnabled: false,
    })
    assert.equal(fourth.response.status, 200)
    assert.deepEqual(fourth.target.attemptedEndpointIds, [
      value.endpoints[0].id,
      value.endpoints[1].id,
    ])
    assert.equal(fourth.target.provider.activeEndpointId, value.endpoints[1].id)
    assert.equal(primaryCalls, 4)
    assert.equal(fallbackCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("pre-output streaming failures switch, including gateways without an SSE content type", async () => {
  const value = provider("semantic-stream")
  const originalFetch = globalThis.fetch
  let primaryCalls = 0
  let fallbackCalls = 0
  const failure = [
    "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
    "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}}\n\n",
  ].join("")
  const success = [
    "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
  ].join("")
  globalThis.fetch = async (_input, init) => {
    if (isPrimary(init, value)) {
      primaryCalls += 1
      return new Response(failure)
    }
    fallbackCalls += 1
    return new Response(success)
  }

  try {
    for (let count = 1; count <= 3; count += 1) {
      const result = await fetchWithEndpointFailover({
        target: target(value),
        path: "v1/responses",
        body: { model: "test-model", input: "hello", stream: true },
        requestIsStream: true,
        capacityRetryEnabled: false,
      })
      assert.equal(result.response.status, 503)
    }

    const fourth = await fetchWithEndpointFailover({
      target: target(value),
      path: "v1/responses",
      body: { model: "test-model", input: "hello", stream: true },
      requestIsStream: true,
      capacityRetryEnabled: false,
    })
    assert.equal(fourth.response.status, 200)
    assert.equal(await fourth.response.text(), success)
    assert.equal(primaryCalls, 4)
    assert.equal(fallbackCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("a failure after visible output is replayed and never switches endpoints", async () => {
  const value = provider("semantic-late-failure")
  const originalFetch = globalThis.fetch
  let fallbackCalls = 0
  const stream = [
    "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"started\"}\n\n",
    "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"late failure\"}}}\n\n",
  ].join("")
  globalThis.fetch = async (_input, init) => {
    if (isPrimary(init, value)) return new Response(stream)
    fallbackCalls += 1
    return new Response("unexpected fallback")
  }

  try {
    const result = await fetchWithEndpointFailover({
      target: target(value),
      path: "v1/responses",
      body: { model: "test-model", input: "hello", stream: true },
      requestIsStream: true,
      capacityRetryEnabled: false,
    })
    assert.deepEqual(result.target.attemptedEndpointIds, [value.endpoints[0].id])
    assert.equal(await result.response.text(), stream)
    assert.equal(fallbackCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("2xx authentication errors switch immediately while invalid requests do not switch", async () => {
  let value = provider("semantic-authentication")
  const originalFetch = globalThis.fetch
  let mode: "authentication" | "invalid-request" = "authentication"
  let fallbackCalls = 0
  globalThis.fetch = async (_input, init) => {
    if (!isPrimary(init, value)) {
      fallbackCalls += 1
      return Response.json({
        id: "resp-ok",
        status: "completed",
        error: null,
        output: [],
      })
    }
    return Response.json({
      status: "failed",
      error:
        mode === "authentication"
          ? { type: "authentication_error", message: "invalid API key" }
          : { type: "invalid_request_error", message: "unsupported parameter" },
      output: [],
    })
  }

  try {
    const authentication = await fetchWithEndpointFailover({
      target: target(value),
      path: "v1/responses",
      body: { model: "test-model", input: "hello", stream: false },
      requestIsStream: false,
      capacityRetryEnabled: false,
    })
    assert.equal(authentication.response.status, 200)
    assert.equal(authentication.target.provider.activeEndpointId, value.endpoints[1].id)
    assert.equal(fallbackCalls, 1)

    value = provider("semantic-invalid-request")
    mode = "invalid-request"
    fallbackCalls = 0
    const invalidRequest = await fetchWithEndpointFailover({
      target: target(value),
      path: "v1/responses",
      body: { model: "test-model", input: "hello", stream: false },
      requestIsStream: false,
      capacityRetryEnabled: false,
    })
    assert.equal(invalidRequest.response.status, 400)
    assert.deepEqual(invalidRequest.target.attemptedEndpointIds, [value.endpoints[0].id])
    assert.equal(fallbackCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})
