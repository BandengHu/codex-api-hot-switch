import assert from "node:assert/strict"
import test from "node:test"

import {
  emptyToolContext,
  responsesToolsToChatTools,
  toolCallItem,
} from "./codex-tool-proxy"
import {
  formatBrowseToolOutput,
  formatSearchToolOutput,
  RELAY_BROWSE_PAGE_TOOL_NAME,
} from "./web-search-relay"
import {
  extractRelayWebToolCalls,
  nextRelayBody,
  relayDisplayItem,
} from "./web-search-relay-state"

test("hosted web search becomes search plus page-reading tools for Chat upstreams", () => {
  const context = emptyToolContext()
  const tools = responsesToolsToChatTools([{ type: "web_search" }], context)

  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ["web_search", "browse_page"],
  )
  assert.equal(context.webSearchTools.has("web_search"), true)
  assert.equal(context.functionTools.has("browse_page"), true)
  assert.equal(
    tools.find((tool) => tool.function.name === "browse_page")
      ?.function.parameters.required[0],
    "url",
  )
})

test("search calls use native display items while page reads remain internal functions", () => {
  const context = emptyToolContext()
  responsesToolsToChatTools([{ type: "web_search" }], context)

  assert.equal(
    toolCallItem("search_1", "web_search", '{"query":"release"}', context).type,
    "web_search_call",
  )
  const browseCall = toolCallItem(
    "browse_1",
    "browse_page",
    '{"url":"https://example.com"}',
    context,
  )
  assert.equal(browseCall.type, "function_call")
  assert.equal(browseCall.name, "browse_page")
})

test("relay output keeps structured sources and readable page content", () => {
  const search = formatSearchToolOutput({
    query: "current release",
    provider: "exa",
    resultCount: 1,
    results: [
      {
        title: "Official release",
        url: "https://example.com/releases/1",
        domain: "example.com",
        publishedAt: "2026-07-26",
        summary: "Release details.",
      },
    ],
  })
  assert.match(search, /URL: https:\/\/example\.com\/releases\/1/)
  assert.match(search, /Published: 2026-07-26/)

  const browse = formatBrowseToolOutput({
    pageCount: 1,
    pages: [
      {
        title: "Official release",
        url: "https://example.com/releases/1",
        domain: "example.com",
        publishedAt: "2026-07-26",
        contentType: "text/html",
        content: "# Release\n\nVerified details.",
        truncated: false,
      },
    ],
  })
  assert.match(browse, /# Release/)
  assert.match(browse, /Truncated: no/)
})

test("page-reading calls are executed through function history and displayed as open_page", () => {
  const upstreamCall = {
    id: "fc_browse_1",
    type: "function_call",
    status: "completed",
    call_id: "browse_1",
    name: "browse_page",
    arguments: '{"url":"https://example.com/docs"}',
  }
  const calls = extractRelayWebToolCalls({ output: [upstreamCall] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].toolName, RELAY_BROWSE_PAGE_TOOL_NAME)

  const next = nextRelayBody(
    {
      input: "Open the official source.",
      previous_response_id: "resp_previous",
      tool_choice: { type: "function", name: "browse_page" },
    },
    { output: [upstreamCall] },
    calls,
    [{ callId: "browse_1", output: "# Documentation" }],
  ) as Record<string, any>
  assert.equal(next.previous_response_id, undefined)
  assert.equal(next.tool_choice, "auto")
  assert.deepEqual(
    next.input.slice(-2).map((item: any) => [item.type, item.name, item.output]),
    [
      ["function_call", "browse_page", undefined],
      ["function_call_output", undefined, "# Documentation"],
    ],
  )

  const display = relayDisplayItem(calls[0], {
    toolName: RELAY_BROWSE_PAGE_TOOL_NAME,
    text: "# Documentation",
    browse: {
      pageCount: 1,
      pages: [{ url: "https://example.com/docs" }],
    },
  })
  assert.equal(display.type, "web_search_call")
  assert.equal(display.action.type, "open_page")
  assert.equal(
    (display.action as { url?: string }).url,
    "https://example.com/docs",
  )
})
