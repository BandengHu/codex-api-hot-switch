import assert from "node:assert/strict"
import test from "node:test"

import {
  upstreamRequiresRefSiblingAllOf,
  wrapRefSiblings,
  wrapRefSiblingsInChatTools,
} from "./moonshot-schema"

test("gate matches Moonshot and Kimi hosts only", () => {
  for (const url of [
    "https://api.moonshot.cn/v1",
    "https://api.moonshot.ai/v1/",
    "https://api.kimi.com/coding/v1",
    "https://API.KIMI.COM/coding/v1",
    " https://api.moonshot.cn/v1/chat/completions ",
  ]) {
    assert.equal(upstreamRequiresRefSiblingAllOf(url), true, url)
  }
  for (const url of [
    "https://api.openai.com/v1",
    "https://example.com/v1",
    "not-a-url",
    "",
  ]) {
    assert.equal(upstreamRequiresRefSiblingAllOf(url), false, url)
  }
})

test("wraps $ref with siblings into allOf", () => {
  const schema = {
    type: "object",
    properties: {
      prompt: { $ref: "#/$defs/__schema20", description: "Prompt to run" },
      mode: { type: "string", enum: ["fast", "slow"] },
    },
    required: ["prompt"],
    $defs: {
      __schema20: { $ref: "#/$defs/__schema2", type: "string", minLength: 1 },
      __schema2: { type: "string" },
    },
  }

  assert.equal(wrapRefSiblings(schema), 2)
  assert.deepEqual(schema.properties.prompt, {
    allOf: [{ $ref: "#/$defs/__schema20" }],
    description: "Prompt to run",
  })
  assert.deepEqual(schema.$defs.__schema20, {
    allOf: [{ $ref: "#/$defs/__schema2" }],
    type: "string",
    minLength: 1,
  })
})

test("does not enter data-valued keywords like default or enum", () => {
  const schema = {
    type: "object",
    properties: {
      mode: {
        type: "string",
        default: { $ref: "not-a-schema" },
        enum: [{ $ref: "also-not-a-schema" }],
      },
    },
  }
  assert.equal(wrapRefSiblings(schema), 0)
})

test("wrapRefSiblingsInChatTools rewrites tool parameters only", () => {
  const body = {
    tools: [
      {
        type: "function",
        function: {
          name: "automation_update",
          parameters: {
            type: "object",
            properties: {
              prompt: { $ref: "#/$defs/__schema20", description: "Prompt" },
            },
            $defs: {
              __schema20: { $ref: "#/$defs/__schema2", type: "string" },
              __schema2: { type: "string" },
            },
          },
        },
      },
    ],
  }

  assert.equal(wrapRefSiblingsInChatTools(body), 1)
  const params = body.tools[0].function.parameters
  assert.deepEqual(params.properties.prompt, {
    allOf: [{ $ref: "#/$defs/__schema20" }],
    description: "Prompt",
  })
})
