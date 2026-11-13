import assert from "node:assert/strict"
import test from "node:test"

import type { ProxyTarget } from "./common"
import { buildChatCompatibleRequest } from "./chat-compatible"
import { normalizeWorkbuddyChatToolSchemas } from "./workbuddy-tool-schema"

function target(providerId: string, baseUrl: string): ProxyTarget {
  return {
    provider: {
      id: providerId,
      name: providerId,
      protocol: "openai-chat",
      baseUrl,
      apiKey: "test-key",
      activeEndpointId: `${providerId}-endpoint`,
      activeEndpointName: "test endpoint",
      headers: [],
      bodyOverride: "",
      endpoints: [],
      timeoutMs: 60_000,
      reasoningDialect: "auto",
      rawResponsesPassthrough: false,
      enabled: true,
      isDefault: false,
      health: "healthy",
    },
    modelId: "deepseek-v4.1-flash",
    requestedModel: "deepseek-v4.1-flash",
    reasoning: "low",
    paused: false,
  }
}

function brokenTools() {
  return [
    {
      type: "function",
      function: {
        name: "write_file",
        description: 123,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "str",
              description: 456,
              maxLength: "10",
            },
            count: {
              type: "int",
              minimum: "1",
              maximum: 99,
            },
            retries: {
              type: "dict",
            },
            tags: {
              type: "list",
              items: { type: "str" },
              uniqueItems: "true",
            },
            choice: {
              type: "str",
              enum: "x",
            },
            flag: {
              type: "bool",
            },
          },
          required: ["path", 2, "count"],
        },
      },
    },
  ]
}

test("normalizes WorkBuddy JSON Schema keywords to their validator types", () => {
  const body = { tools: brokenTools() }
  assert.equal(normalizeWorkbuddyChatToolSchemas(body), 1)

  const fn = body.tools[0].function
  const parameters = fn.parameters as Record<string, any>
  const properties = parameters.properties
  assert.equal(fn.description, "123")
  assert.equal(parameters.type, "object")
  assert.equal(properties.path.type, "string")
  assert.equal(properties.path.description, "456")
  assert.equal(properties.path.maxLength, 10)
  assert.equal(properties.count.type, "integer")
  assert.equal(properties.count.minimum, 1)
  assert.equal(properties.retries.type, "object")
  assert.deepEqual(properties.retries.properties, {})
  assert.equal(properties.tags.type, "array")
  assert.equal(properties.tags.items.type, "string")
  assert.equal(properties.tags.uniqueItems, true)
  assert.equal(properties.choice.type, "string")
  assert.equal("enum" in properties.choice, false)
  assert.equal(properties.flag.type, "boolean")
  assert.deepEqual(parameters.required, ["path", "count"])
})

test("normalizes top-level function tool parameters in place", () => {
  const body = {
    tools: [{
      type: "function",
      name: "search",
      description: 789,
      parameters: {
        type: "object",
        properties: {
          query: { type: "str", minLength: "2" },
        },
      },
    }],
  }
  normalizeWorkbuddyChatToolSchemas(body)
  const tool = body.tools[0]
  const parameters = tool.parameters as Record<string, any>
  assert.equal(tool.description, "789")
  assert.equal(parameters.type, "object")
  assert.equal(parameters.properties.query.type, "string")
  assert.equal(parameters.properties.query.minLength, 2)
})

test("Chat and Responses only normalize tools on the WorkBuddy route", () => {
  for (const path of ["v1/chat/completions", "v1/responses"]) {
    const workbuddy = buildChatCompatibleRequest(
      target("prov-workbuddy", "https://www.codebuddy.cn/v2"),
      path,
      path.endsWith("responses")
        ? {
            model: "client-model",
            input: "hello",
            tools: brokenTools(),
            stream: true,
          }
        : {
            model: "client-model",
            messages: [{ role: "user", content: "hello" }],
            tools: brokenTools(),
            stream: true,
          },
    )
    const normalizedTool = (workbuddy.rewrittenBody as any).tools[0]
    assert.equal(normalizedTool.function.parameters.properties.path.type, "string")

    const ordinaryTools = brokenTools()
    const ordinary = buildChatCompatibleRequest(
      target("provider-chat", "https://example.com/v1"),
      path,
      path.endsWith("responses")
        ? {
            model: "client-model",
            input: "hello",
            tools: ordinaryTools,
            stream: true,
          }
        : {
            model: "client-model",
            messages: [{ role: "user", content: "hello" }],
            tools: ordinaryTools,
            stream: true,
          },
    )
    const ordinaryTool = (ordinary.rewrittenBody as any).tools[0]
    assert.equal(ordinaryTool.function.parameters.properties.path.type, "str")
    assert.equal(ordinaryTool.function.parameters.properties.path.maxLength, "10")
  }
})
