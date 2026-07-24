import assert from "node:assert/strict"
import test from "node:test"

import { prepareCodexOpenAICompatibleRequest } from "./codex-protocol"
import {
  restoreCompatibleResponsesToolCalls,
} from "./responses-tool-search-compat"
import {
  parseSseFrames,
  transformResponsesSseText,
} from "./responses-sse"

const toolSearch = {
  type: "tool_search",
  execution: "client",
  description: "Search deferred tools.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
    additionalProperties: false,
  },
}

const loadedNamespace = {
  type: "namespace",
  name: "mcp__switchgate_web_search",
  description: "SwitchGate web search.",
  tools: [
    {
      type: "function",
      name: "web_search",
      description: "Search the web.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
}

function prepare(
  body: Record<string, any>,
  rawResponsesPassthrough = false,
  compatibleResponsesToolSearch = true,
) {
  return prepareCodexOpenAICompatibleRequest(
    "v1/responses",
    body,
    "upstream-model",
    "high",
    { rawResponsesPassthrough, compatibleResponsesToolSearch },
  )
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function streamForFunctionCall(name: string, callId: string, argumentsText: string) {
  const itemId = `upstream_${callId}`
  const item = {
    id: itemId,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    arguments: argumentsText,
  }
  const response = {
    id: `resp_${callId}`,
    object: "response",
    status: "completed",
    model: "upstream-model",
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
  return [
    sse("response.created", {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    }),
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    }),
    sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsText,
    }),
    sse("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      arguments: argumentsText,
    }),
    sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    }),
    sse("response.completed", {
      type: "response.completed",
      response,
    }),
    "data: [DONE]\n\n",
  ].join("")
}

test("non-passthrough Responses converts tool_search into a standard function", () => {
  const prepared = prepare({
    model: "client-model",
    stream: true,
    input: "Find a search tool.",
    tools: [
      toolSearch,
      {
        type: "function",
        name: "keep_me",
        description: "Keep this function unchanged.",
        parameters: { type: "object", properties: {} },
      },
    ],
  })

  assert.equal(prepared.adapter.type, "passthrough")
  assert.equal(prepared.body.tools.some((tool: any) => tool.type === "tool_search"), false)
  assert.deepEqual(
    prepared.body.tools.find((tool: any) => tool.name === "tool_search"),
    {
      type: "function",
      name: "tool_search",
      description: "Search deferred tools.",
      parameters: toolSearch.parameters,
    },
  )
  assert.equal(prepared.body.tools.some((tool: any) => tool.name === "keep_me"), true)
  assert.equal(
    prepared.adapter.type === "passthrough" &&
      prepared.adapter.toolContext?.toolSearchTools.has("tool_search"),
    true,
  )
})

test("raw Responses passthrough preserves Codex tool_search wire shape", () => {
  const input = {
    model: "client-model",
    stream: true,
    input: "Find a search tool.",
    tools: [toolSearch],
  }
  const prepared = prepare(input, true)

  assert.deepEqual(prepared.body.tools, input.tools)
  assert.equal(prepared.body.input, input.input)
  assert.equal(prepared.adapter.type === "passthrough" && prepared.adapter.toolContext, undefined)
})

test("captures incremental history without cloning the full Responses input", () => {
  const inputItems = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    },
  ]
  const prepared = prepare({
    model: "client-model",
    previous_response_id: "resp_previous",
    input: inputItems,
  })

  assert.equal(prepared.adapter.type, "passthrough")
  if (prepared.adapter.type !== "passthrough") return
  assert.equal(prepared.adapter.historyRequestBody?.input, inputItems)
  assert.equal(
    prepared.adapter.historyRequestBody?.previous_response_id,
    "resp_previous",
  )
  assert.notEqual(prepared.body.input, inputItems)
  assert.deepEqual(inputItems, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "continue" }],
    },
  ])
})

test("native-compatible Responses preserves Codex tool_search wire shape", () => {
  const input = {
    model: "client-model",
    stream: true,
    input: [
      {
        type: "tool_search_call",
        call_id: "search_native",
        execution: "client",
        arguments: { query: "native search" },
      },
      {
        type: "tool_search_output",
        call_id: "search_native",
        status: "completed",
        execution: "client",
        tools: [loadedNamespace],
      },
    ],
    tools: [toolSearch],
  }
  const prepared = prepare(input, false, false)

  assert.deepEqual(prepared.body.tools, input.tools)
  assert.deepEqual(prepared.body.input, input.input)
  assert.equal(prepared.adapter.type === "passthrough" && prepared.adapter.toolContext != null, true)
})

test("tool_search history and discovered namespace tools are adapted for follow-up requests", () => {
  const prepared = prepare({
    model: "client-model",
    stream: true,
    tools: [toolSearch],
    input: [
      {
        type: "tool_search_call",
        call_id: "search_1",
        execution: "client",
        arguments: { query: "web search" },
      },
      {
        type: "tool_search_output",
        call_id: "search_1",
        status: "completed",
        execution: "client",
        tools: [loadedNamespace],
      },
    ],
  })

  assert.deepEqual(prepared.body.input[0], {
    type: "function_call",
    call_id: "search_1",
    name: "tool_search",
    arguments: JSON.stringify({ query: "web search" }),
  })
  assert.equal(prepared.body.input[1].type, "function_call_output")
  assert.match(prepared.body.input[1].output, /switchgate_web_search/)
  assert.equal(
    prepared.body.tools.some(
      (tool: any) => tool.name === "mcp__switchgate_web_search__web_search",
    ),
    true,
  )
  assert.deepEqual(
    prepared.adapter.type === "passthrough"
      ? prepared.adapter.toolContext?.functionTools.get(
          "mcp__switchgate_web_search__web_search",
        )
      : undefined,
    {
      namespace: "mcp__switchgate_web_search",
      name: "web_search",
    },
  )
})

test("streaming tool_search function calls are restored to Codex tool_search_call events", () => {
  const prepared = prepare({
    model: "client-model",
    stream: true,
    input: "Find web search.",
    tools: [toolSearch],
  })
  assert.equal(prepared.adapter.type, "passthrough")

  const transformed = transformResponsesSseText(
    streamForFunctionCall(
      "tool_search",
      "search_1",
      JSON.stringify({ query: "SwitchGate web search", limit: 4 }),
    ),
    { toolContext: prepared.adapter.toolContext },
  )
  const frames = parseSseFrames(transformed.text)
  const added = frames.find((frame) => frame.event === "response.output_item.added")?.data
  const done = frames.find((frame) => frame.event === "response.output_item.done")?.data
  const completed = frames.find((frame) => frame.event === "response.completed")?.data

  assert.equal(added.item.type, "tool_search_call")
  assert.equal(done.item.type, "tool_search_call")
  assert.deepEqual(done.item.arguments, {
    query: "SwitchGate web search",
    limit: 4,
  })
  assert.equal(completed.response.output[0].type, "tool_search_call")
  assert.equal(
    frames.some((frame) => frame.event.startsWith("response.function_call_arguments")),
    false,
  )
})

test("streaming discovered namespace calls are restored to namespace function calls", () => {
  const prepared = prepare({
    model: "client-model",
    stream: true,
    tools: [toolSearch],
    input: [
      {
        type: "tool_search_output",
        call_id: "search_1",
        tools: [loadedNamespace],
      },
    ],
  })
  assert.equal(prepared.adapter.type, "passthrough")

  const transformed = transformResponsesSseText(
    streamForFunctionCall(
      "mcp__switchgate_web_search__web_search",
      "web_1",
      JSON.stringify({ query: "Codex tool_search" }),
    ),
    { toolContext: prepared.adapter.toolContext },
  )
  const frames = parseSseFrames(transformed.text)
  const added = frames.find((frame) => frame.event === "response.output_item.added")?.data
  const delta = frames.find(
    (frame) => frame.event === "response.function_call_arguments.delta",
  )?.data
  const done = frames.find((frame) => frame.event === "response.output_item.done")?.data
  const completed = frames.find((frame) => frame.event === "response.completed")?.data

  assert.equal(added.item.type, "function_call")
  assert.equal(added.item.name, "web_search")
  assert.equal(added.item.namespace, "mcp__switchgate_web_search")
  assert.equal(delta.item_id, "fc_web_1")
  assert.equal(done.item.name, "web_search")
  assert.equal(done.item.namespace, "mcp__switchgate_web_search")
  assert.equal(completed.response.output[0].name, "web_search")
  assert.equal(
    completed.response.output[0].namespace,
    "mcp__switchgate_web_search",
  )
})

test("non-streaming compatible Responses restores proxied tool calls", () => {
  const prepared = prepare({
    model: "client-model",
    stream: false,
    tools: [toolSearch],
    input: [
      {
        type: "tool_search_output",
        call_id: "search_1",
        tools: [loadedNamespace],
      },
    ],
  })
  assert.equal(prepared.adapter.type, "passthrough")

  const restored = restoreCompatibleResponsesToolCalls(
    {
      id: "resp_1",
      output: [
        {
          type: "function_call",
          call_id: "search_2",
          name: "tool_search",
          arguments: JSON.stringify({ query: "MCP" }),
        },
        {
          type: "function_call",
          call_id: "web_2",
          name: "mcp__switchgate_web_search__web_search",
          arguments: JSON.stringify({ query: "Codex" }),
        },
      ],
    },
    prepared.adapter.toolContext,
  ) as Record<string, any>

  assert.equal(restored.output[0].type, "tool_search_call")
  assert.equal(restored.output[1].type, "function_call")
  assert.equal(restored.output[1].name, "web_search")
  assert.equal(restored.output[1].namespace, "mcp__switchgate_web_search")
})
