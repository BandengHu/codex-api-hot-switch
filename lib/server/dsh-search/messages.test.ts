import assert from "node:assert/strict"
import test from "node:test"
import {
  buildDshSearchResponse,
  extractDshSearchQuery,
  extractDshSearchQueries,
  resolveDshSearchLimit,
} from "./messages"

test("extracts the query from the official DSH search prompt", () => {
  assert.equal(
    extractDshSearchQuery({
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "Perform a web search for the query: latest DeepSeek release",
        }],
      }],
    }),
    "latest DeepSeek release",
  )
})

test("extracts every query from a multi-query DSH search prompt", () => {
  assert.deepEqual(
    extractDshSearchQueries({
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: [
            "Perform a web search for the query: latest DeepSeek release",
            "Perform a web search for the query: DeepSeek API documentation",
          ].join("\n"),
        }],
      }],
    }),
    ["latest DeepSeek release", "DeepSeek API documentation"],
  )
})

test("resolves the DSH result limit from supported request fields", () => {
  assert.equal(resolveDshSearchLimit({ max_results: 3 }), 3)
  assert.equal(resolveDshSearchLimit({ maxResults: 4 }), 4)
  assert.equal(resolveDshSearchLimit({ searchMaxResults: 5 }), 5)
  assert.equal(resolveDshSearchLimit({ max_results: 0, maxResults: 99 }), 20)
})

test("builds Anthropic content blocks that DSH can map to sources", () => {
  const response = buildDshSearchResponse(
    { model: "deepseek-v4-flash" },
    {
      groups: [{
        query: "latest DeepSeek release",
        total: 1,
        limit: 8,
        hasMore: false,
        provider: "exa",
        capabilities: {
          site: "query",
          exactPhrase: "query",
          timeRange: "query",
          language: "query",
        },
        results: [{
          query: "latest DeepSeek release",
          title: "Release notes",
          url: "https://example.com/release",
          domain: "example.com",
          summary: "A concise release summary.",
          score: 0.9,
          publishedAt: "2026-09-27",
          provider: "exa",
        }],
        scoreBasis: "relative",
      }],
      errors: [],
    },
  )

  assert.equal(response.type, "message")
  const toolResult = response.content[0] as {
    type: "web_search_tool_result"
    content: Array<{
      type: string
      url: string
      page_age?: string
    }>
  }
  const textResult = response.content[1] as {
    type: "text"
    text: string
    citations: Array<{ url: string }>
  }
  const searchResult = toolResult.content[0]
  assert.ok(searchResult)
  assert.equal(toolResult.type, "web_search_tool_result")
  assert.equal(searchResult.type, "web_search_result")
  assert.equal(searchResult.page_age, "2026-09-27")
  assert.equal(textResult.citations[0].url, "https://example.com/release")
  assert.match(textResult.text, /A concise release summary/u)
})

test("keeps multi-query results in separate DSH tool result blocks", () => {
  const response = buildDshSearchResponse(
    { model: "deepseek-v4-flash" },
    {
      groups: [
        {
          query: "first query",
          total: 2,
          limit: 1,
          hasMore: true,
          provider: "exa",
          capabilities: {
            site: "query",
            exactPhrase: "query",
            timeRange: "query",
            language: "query",
          },
          results: [{
            query: "first query",
            title: "First result",
            url: "https://example.com/first",
            domain: "example.com",
            summary: "First summary.",
            score: 0.8,
            publishedAt: null,
            provider: "exa",
          }],
          scoreBasis: "relative",
        },
        {
          query: "second query",
          total: 1,
          limit: 1,
          hasMore: false,
          provider: "exa",
          capabilities: {
            site: "query",
            exactPhrase: "query",
            timeRange: "query",
            language: "query",
          },
          results: [{
            query: "second query",
            title: "Second result",
            url: "https://example.com/second",
            domain: "example.com",
            summary: "Second summary.",
            score: 0.7,
            publishedAt: "2026-09-27",
            provider: "exa",
          }],
          scoreBasis: "relative",
        },
      ],
      errors: [],
    },
  )

  const toolResults = response.content.filter(
    (item) => item.type === "web_search_tool_result",
  ) as Array<{
    type: "web_search_tool_result"
    content: Array<{ url: string }>
  }>
  assert.equal(toolResults.length, 2)
  assert.equal(toolResults[0].content[0].url, "https://example.com/first")
  assert.equal(toolResults[1].content[0].url, "https://example.com/second")

  const textResult = response.content.at(-1) as {
    type: "text"
    text: string
    citations: Array<{ cited_text: string }>
  }
  assert.ok(textResult)
  assert.equal(textResult.type, "text")
  assert.match(textResult.text, /Query: first query/u)
  assert.match(textResult.text, /Showing 1 of 2; more results are available\./u)
  assert.match(textResult.text, /Query: second query/u)
  assert.match(textResult.text, /Scores are relative within this query/u)
  assert.match(textResult.citations[0].cited_text, /query=first query/u)
  assert.match(textResult.citations[0].cited_text, /score=0\.80 \(relative\)/u)
  assert.match(textResult.citations[0].cited_text, /result=1\/2; more=true/u)
  assert.match(textResult.citations[1].cited_text, /query=second query/u)
})
