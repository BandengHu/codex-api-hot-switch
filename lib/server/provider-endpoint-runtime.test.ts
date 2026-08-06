import assert from "node:assert/strict"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"
import type { Model, Provider } from "@/lib/types"
import type { ProxyTarget } from "./proxy/common"

const dataDir = join(
  tmpdir(),
  `switchgate-endpoint-test-${process.pid}-${Date.now()}`,
)
process.env.CODEX_HOT_SWITCH_DATA_DIR = dataDir

let runtime: typeof import("./provider-endpoint-runtime")
let getSnapshot: typeof import("./state-store").getSnapshot
let saveSnapshot: typeof import("./state-store").saveSnapshot
let fetchWithEndpointFailover: typeof import("./proxy/endpoint-failover").fetchWithEndpointFailover
let runModelTest: typeof import("./model-test").runModelTest

test.before(async () => {
  await mkdir(dataDir, { recursive: true })
  await writeFile(
    join(dataDir, "hot-switch-state.json"),
    `${JSON.stringify({
      version: 1,
      providers: [
        {
          id: "legacy-provider",
          name: "旧供应商",
          protocol: "openai-responses",
          baseUrl: "https://legacy.example/v1",
          apiKey: "legacy-key",
          headers: [],
          bodyOverride: "",
          timeoutMs: 60000,
          reasoningDialect: "auto",
          rawResponsesPassthrough: true,
          enabled: true,
          isDefault: true,
          health: "healthy",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  )
  runtime = await import("./provider-endpoint-runtime")
  const stateStore = await import("./state-store")
  getSnapshot = stateStore.getSnapshot
  saveSnapshot = stateStore.saveSnapshot
  fetchWithEndpointFailover = (
    await import("./proxy/endpoint-failover")
  ).fetchWithEndpointFailover
  runModelTest = (await import("./model-test")).runModelTest
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
    timeoutMs: 60000,
    reasoningDialect: "auto",
    rawResponsesPassthrough: true,
    enabled: true,
    isDefault: false,
    health: "healthy",
  }
}

function proxyTarget(value: Provider): ProxyTarget {
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

test("migrates legacy provider credentials into one endpoint and removes legacy fields", async () => {
  const snapshot = await getSnapshot()
  const migrated = snapshot.providers.find((item) => item.id === "legacy-provider")
  assert.ok(migrated)
  assert.deepEqual(migrated.endpoints, [
    {
      id: "legacy-provider-primary",
      name: "主用",
      baseUrl: "https://legacy.example/v1",
      apiKey: "legacy-key",
      enabled: true,
    },
  ])
  assert.equal("baseUrl" in migrated, false)
  assert.equal("apiKey" in migrated, false)

  const stored = JSON.parse(
    await readFile(join(dataDir, "hot-switch-state.json"), "utf8"),
  ) as { providers: Array<Record<string, unknown>> }
  assert.equal("baseUrl" in stored.providers[0], false)
  assert.equal("apiKey" in stored.providers[0], false)
})

test("single-provider availability lookup does not prune other providers", async () => {
  const first = provider("first")
  const second = provider("second")
  await runtime.getProviderEndpointRuntimeStates([first, second])
  await runtime.recordProviderEndpointFailure(
    second,
    second.endpoints[0],
    { kind: "transient", message: "temporary" },
  )

  await runtime.availableProviderEndpoints(first)
  const states = await runtime.getProviderEndpointRuntimeStates([first, second])
  const secondState = states.find(
    (state) =>
      state.providerId === second.id &&
      state.endpointId === second.endpoints[0].id,
  )
  assert.equal(secondState?.consecutiveFailures, 1)
})

test("transient failures switch only on the fourth consecutive failure", async () => {
  const value = provider("threshold")
  for (let count = 1; count <= 3; count += 1) {
    const result = await runtime.recordProviderEndpointFailure(
      value,
      value.endpoints[0],
      { kind: "transient", message: `failure-${count}` },
    )
    assert.equal(result.shouldFailover, false)
    assert.equal(result.state.consecutiveFailures, count)
  }

  const fourth = await runtime.recordProviderEndpointFailure(
    value,
    value.endpoints[0],
    { kind: "transient", message: "failure-4" },
  )
  assert.equal(fourth.shouldFailover, true)
  assert.ok(fourth.state.cooldownUntil)
  assert.ok(Date.parse(fourth.state.cooldownUntil || "") > Date.now())

  await runtime.recordProviderEndpointSuccess(value, value.endpoints[0])
  const reset = await runtime.getProviderEndpointRuntimeStates([value])
  assert.equal(reset[0].consecutiveFailures, 0)
  assert.equal(reset[0].cooldownUntil, undefined)
})

test("last available endpoint stays active after the transient failure threshold", async () => {
  const value = provider("last-available")
  await runtime.recordProviderEndpointFailure(
    value,
    value.endpoints[1],
    { kind: "quota", message: "fallback quota exhausted" },
  )

  let latest:
    | Awaited<ReturnType<typeof runtime.recordProviderEndpointFailure>>
    | undefined
  for (let count = 1; count <= runtime.ENDPOINT_FAILURE_THRESHOLD; count += 1) {
    latest = await runtime.recordProviderEndpointFailure(
      value,
      value.endpoints[0],
      { kind: "transient", message: `primary failure ${count}` },
    )
  }

  assert.ok(latest)
  assert.equal(latest.shouldFailover, false)
  assert.equal(latest.state.consecutiveFailures, runtime.ENDPOINT_FAILURE_THRESHOLD)
  assert.equal(latest.state.cooldownUntil, undefined)
  assert.deepEqual(
    (await runtime.availableProviderEndpoints(value)).map((endpoint) => endpoint.id),
    [value.endpoints[0].id],
  )
})

test("removing the fallback immediately releases an existing primary cooldown", async () => {
  const value = provider("removed-fallback")
  for (let count = 0; count < runtime.ENDPOINT_FAILURE_THRESHOLD; count += 1) {
    await runtime.recordProviderEndpointFailure(
      value,
      value.endpoints[0],
      { kind: "transient", message: `primary failure ${count + 1}` },
    )
  }

  const cooled = await runtime.getProviderEndpointRuntimeStates([value])
  assert.ok(cooled[0].cooldownUntil)

  const singleEndpointProvider = {
    ...value,
    endpoints: [value.endpoints[0]],
  }
  assert.deepEqual(
    (await runtime.availableProviderEndpoints(singleEndpointProvider)).map(
      (endpoint) => endpoint.id,
    ),
    [value.endpoints[0].id],
  )
  const released = await runtime.getProviderEndpointRuntimeStates([
    singleEndpointProvider,
  ])
  assert.equal(released[0].cooldownUntil, undefined)
})

test("disabling the fallback immediately releases an existing primary cooldown", async () => {
  const value = provider("disabled-fallback")
  for (let count = 0; count < runtime.ENDPOINT_FAILURE_THRESHOLD; count += 1) {
    await runtime.recordProviderEndpointFailure(
      value,
      value.endpoints[0],
      { kind: "transient", message: `primary failure ${count + 1}` },
    )
  }

  const fallbackDisabledProvider = {
    ...value,
    endpoints: value.endpoints.map((endpoint, index) =>
      index === 1 ? { ...endpoint, enabled: false } : endpoint,
    ),
  }
  assert.deepEqual(
    (await runtime.availableProviderEndpoints(fallbackDisabledProvider)).map(
      (endpoint) => endpoint.id,
    ),
    [value.endpoints[0].id],
  )
  const released = await runtime.getProviderEndpointRuntimeStates([
    fallbackDisabledProvider,
  ])
  assert.equal(released[0].cooldownUntil, undefined)
})

test("removing the fallback re-enables a quota-disabled primary endpoint", async () => {
  const value = provider("removed-after-quota")
  const failed = await runtime.recordProviderEndpointFailure(
    value,
    value.endpoints[0],
    { kind: "quota", message: "quota exhausted" },
  )
  assert.equal(failed.shouldFailover, true)
  assert.equal(failed.state.quotaDisabled, true)

  const singleEndpointProvider = {
    ...value,
    endpoints: [value.endpoints[0]],
  }
  assert.deepEqual(
    (await runtime.availableProviderEndpoints(singleEndpointProvider)).map(
      (endpoint) => endpoint.id,
    ),
    [value.endpoints[0].id],
  )
  const released = await runtime.getProviderEndpointRuntimeStates([
    singleEndpointProvider,
  ])
  assert.equal(released[0].quotaDisabled, false)
})

test("expired cooldown restores the endpoint with a fresh failure count", async () => {
  const value = provider("cooldown-expiry")
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  try {
    for (let count = 0; count < runtime.ENDPOINT_FAILURE_THRESHOLD; count += 1) {
      await runtime.recordProviderEndpointFailure(
        value,
        value.endpoints[0],
        { kind: "transient", message: `failure-${count + 1}` },
      )
    }
    now += runtime.ENDPOINT_COOLDOWN_MS + 1
    const available = await runtime.availableProviderEndpoints(value)
    assert.equal(available[0]?.id, value.endpoints[0].id)
    const states = await runtime.getProviderEndpointRuntimeStates([value])
    assert.equal(states[0].consecutiveFailures, 0)
    assert.equal(states[0].cooldownUntil, undefined)
    assert.equal(states[0].lastError, undefined)
  } finally {
    Date.now = originalNow
  }
})

test("manually re-enabling an endpoint clears quota and cooldown state", async () => {
  const value = provider("manual-enable")
  let snapshot = await getSnapshot()
  snapshot = await saveSnapshot({
    ...snapshot,
    providers: [...snapshot.providers, value],
  })
  await runtime.recordProviderEndpointFailure(
    value,
    value.endpoints[0],
    { kind: "quota", message: "quota exhausted" },
  )

  const disabled = {
    ...value,
    endpoints: value.endpoints.map((endpoint, index) =>
      index === 0 ? { ...endpoint, enabled: false } : endpoint,
    ),
  }
  snapshot = await saveSnapshot({
    ...snapshot,
    providers: snapshot.providers.map((item) =>
      item.id === value.id ? disabled : item,
    ),
  })
  const disabledState = snapshot.endpointStates.find(
    (state) =>
      state.providerId === value.id &&
      state.endpointId === value.endpoints[0].id,
  )
  assert.equal(disabledState?.quotaDisabled, true)

  snapshot = await saveSnapshot({
    ...snapshot,
    providers: snapshot.providers.map((item) =>
      item.id === value.id ? value : item,
    ),
  })
  const reenabledState = snapshot.endpointStates.find(
    (state) =>
      state.providerId === value.id &&
      state.endpointId === value.endpoints[0].id,
  )
  assert.equal(reenabledState?.quotaDisabled, false)
  assert.equal(reenabledState?.consecutiveFailures, 0)
  assert.equal(reenabledState?.cooldownUntil, undefined)
})

test("classifies quota, authentication and terminal HTTP errors", () => {
  assert.equal(
    runtime.classifyEndpointFailure({
      status: 429,
      payload: { error: { code: "DAILY_LIMIT_EXCEEDED" } },
    }).kind,
    "quota",
  )
  assert.equal(runtime.classifyEndpointFailure({ status: 401 }).kind, "auth")
  assert.equal(runtime.classifyEndpointFailure({ status: 403 }).kind, "terminal")
  assert.equal(runtime.classifyEndpointFailure({ status: 400 }).kind, "terminal")
  assert.equal(runtime.classifyEndpointFailure({ status: 503 }).kind, "transient")
  assert.equal(
    runtime.classifyEndpointFailure({
      status: 503,
      payload: {
        error: {
          message:
            "No available channel for model gpt-5.6-luna under group gpt-额度计费",
          code: "model_not_found",
        },
      },
    }).kind,
    "terminal",
  )
  assert.equal(
    runtime.classifyEndpointFailure({
      status: 429,
      payload: { error: { code: "rate_limit_exceeded" } },
    }).kind,
    "transient",
  )
})

test("quota and authentication errors do not disable the only endpoint", async () => {
  for (const kind of ["quota", "auth"] as const) {
    const value = provider(`single-${kind}`)
    const singleEndpointProvider = {
      ...value,
      endpoints: [value.endpoints[0]],
    }
    const result = await runtime.recordProviderEndpointFailure(
      singleEndpointProvider,
      singleEndpointProvider.endpoints[0],
      { kind, message: `${kind} failure` },
    )
    assert.equal(result.shouldFailover, false)
    assert.equal(result.state.quotaDisabled, false)
    assert.equal(result.state.authDisabled, false)
    assert.deepEqual(
      (await runtime.availableProviderEndpoints(singleEndpointProvider)).map(
        (endpoint) => endpoint.id,
      ),
      [singleEndpointProvider.endpoints[0].id],
    )
  }
})

test("endpoint failover keeps the first three failures on the primary and switches on the fourth", async () => {
  const value = provider("request-flow")
  const target = proxyTarget(value)
  const originalFetch = globalThis.fetch
  let primaryCalls = 0
  let fallbackCalls = 0
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers)
    if (headers.get("authorization") === `Bearer ${value.endpoints[0].apiKey}`) {
      primaryCalls += 1
      return Response.json(
        { error: { message: "temporary upstream error" } },
        { status: 503 },
      )
    }
    fallbackCalls += 1
    return Response.json({
      id: "resp-ok",
      object: "response",
      output: [],
    })
  }

  try {
    for (let count = 1; count <= 3; count += 1) {
      const result = await fetchWithEndpointFailover({
        target,
        path: "v1/responses",
        body: { model: "test-model", input: "hello", stream: false },
        requestIsStream: false,
        capacityRetryEnabled: false,
      })
      assert.equal(result.response.status, 503)
      assert.deepEqual(result.target.attemptedEndpointIds, [value.endpoints[0].id])
    }

    const fourth = await fetchWithEndpointFailover({
      target,
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
    assert.match(fourth.target.failoverReason || "", /temporary upstream error/)
    assert.equal(primaryCalls, 4)
    assert.equal(fallbackCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("quota switches immediately while plain 403 stays on the current endpoint", async () => {
  const value = provider("classification-flow")
  const target = proxyTarget(value)
  const originalFetch = globalThis.fetch
  let mode: "quota" | "forbidden" = "quota"
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls += 1
    const headers = new Headers(init?.headers)
    const primary =
      headers.get("authorization") === `Bearer ${value.endpoints[0].apiKey}`
    if (!primary) {
      return Response.json({ id: "resp-ok", object: "response", output: [] })
    }
    return mode === "quota"
      ? Response.json(
          { error: { code: "DAILY_LIMIT_EXCEEDED", message: "daily usage limit exceeded" } },
          { status: 429 },
        )
      : Response.json(
          { error: { message: "forbidden" } },
          { status: 403 },
        )
  }

  try {
    const quota = await fetchWithEndpointFailover({
      target,
      path: "v1/responses",
      body: { model: "test-model", input: "hello", stream: false },
      requestIsStream: false,
      capacityRetryEnabled: false,
    })
    assert.equal(quota.response.status, 200)
    assert.equal(quota.target.provider.activeEndpointId, value.endpoints[1].id)
    assert.equal(calls, 2)

    await runtime.resetProviderEndpointRuntime(value.id, value.endpoints[0].id)
    mode = "forbidden"
    calls = 0
    const forbidden = await fetchWithEndpointFailover({
      target,
      path: "v1/responses",
      body: { model: "test-model", input: "hello", stream: false },
      requestIsStream: false,
      capacityRetryEnabled: false,
    })
    assert.equal(forbidden.response.status, 403)
    assert.deepEqual(forbidden.target.attemptedEndpointIds, [
      value.endpoints[0].id,
    ])
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("model test uses the same endpoint failover path", async () => {
  const value = provider("model-test-flow")
  const model: Model = {
    id: "model-test-flow-model",
    providerId: value.id,
    displayName: "Model Test",
    modelId: "test-model",
    capabilities: ["chat"],
    contextLength: 128000,
    supportsReasoning: false,
    reasoningDialect: "inherit",
    supportsVision: false,
    enabled: true,
  }
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls += 1
    const headers = new Headers(init?.headers)
    if (headers.get("authorization") === `Bearer ${value.endpoints[0].apiKey}`) {
      return Response.json(
        { error: { code: "DAILY_LIMIT_EXCEEDED", message: "daily usage limit exceeded" } },
        { status: 429 },
      )
    }
    return Response.json({
      id: "resp-ok",
      object: "response",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "OK" }],
        },
      ],
    })
  }

  try {
    const result = await runModelTest({ provider: value, model })
    assert.equal(result.ok, true)
    assert.equal(result.outputText, "OK")
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("stream pre-read replays every buffered SSE byte and rejects an empty stream", async () => {
  const encoder = new TextEncoder()
  const chunks = [
    "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"好\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
  ]
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  const prepared = await runtime.prepareUpstreamResponse(response, true)
  assert.equal(await prepared.text(), chunks.join(""))

  const empty = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  await assert.rejects(
    () => runtime.prepareUpstreamResponse(empty, true),
    /空流/,
  )

  const failedBeforeContent = new Response(
    [
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"message\"}}\n\n",
      "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"failed before content\"}}}\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
  await assert.rejects(
    () => runtime.prepareUpstreamResponse(failedBeforeContent, true),
    /failed before content/,
  )
})

test("stream pre-read stops on first semantic event timeout", async () => {
  const waiting = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined)
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  await assert.rejects(
    () => runtime.prepareUpstreamResponse(waiting, true, { timeoutMs: 20 }),
    /首个有效输出前超时/,
  )
})

test("stream pre-read treats client cancellation as cancellation", async () => {
  const controller = new AbortController()
  const waiting = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined)
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
  const pending = runtime.prepareUpstreamResponse(waiting, true, {
    requestSignal: controller.signal,
    timeoutMs: 1000,
  })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(pending, /客户端已取消/)
})

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})
