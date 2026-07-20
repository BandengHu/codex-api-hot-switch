"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")
const zlib = require("node:zlib")
const {
  extractPage,
  parseHtmlDocument,
} = require("./web-search-mcp/content-extractor.cjs")
const {
  decodeContentEncoding,
  isForbiddenIp,
  normalizeBrowsePageInput,
  validatePublicUrl,
} = require("./web-search-mcp/page-reader.cjs")
const {
  normalizeSearchResults,
  parseWebSearchMcpResponse,
} = require("./web-search-mcp/search.cjs")
const { handleRequest } = require("./web-search-mcp/server.cjs")

test("normalizes Exa labeled results into stable fields", () => {
  const text = [
    "Title: Example story",
    "URL: https://www.example.com/news/story",
    "Published: 2026-07-20T01:02:03.000Z",
    "Author: Example",
    "Highlights:",
    "Example story",
    "...",
    "A useful summary with current details.",
    "",
    "---",
    "",
    "Title: Undated source",
    "URL: https://docs.example.org/item",
    "Highlights:",
    "Primary documentation.",
  ].join("\n")
  assert.deepEqual(normalizeSearchResults(text), [
    {
      title: "Example story",
      url: "https://www.example.com/news/story",
      domain: "example.com",
      publishedAt: "2026-07-20T01:02:03.000Z",
      summary: "A useful summary with current details.",
    },
    {
      title: "Undated source",
      url: "https://docs.example.org/item",
      domain: "docs.example.org",
      publishedAt: null,
      summary: "Primary documentation.",
    },
  ])
})

test("normalizes structured JSON search results without inventing dates", () => {
  const results = normalizeSearchResults(
    JSON.stringify({
      results: [
        {
          title: "Official docs",
          url: "https://example.com/docs",
          snippet: "Reference content",
        },
      ],
    }),
  )
  assert.equal(results.length, 1)
  assert.equal(results[0].publishedAt, null)
  assert.equal(results[0].summary, "Reference content")
})

test("extracts text and metadata from an MCP SSE payload", () => {
  const body = [
    "event: message",
    'data: {"result":{"content":[{"type":"text","text":"Title: A\\nURL: https://example.com"}]}}',
    "",
  ].join("\n")
  assert.equal(parseWebSearchMcpResponse(body), "Title: A\nURL: https://example.com")
})

test("HTML parser prefers article text and ignores navigation and scripts", () => {
  const html = `
    <html>
      <head>
        <title>Fallback title</title>
        <meta property="og:title" content="Article title">
        <meta property="article:published_time" content="2026-07-19T10:00:00Z">
        <script>window.secret = "do not expose"</script>
      </head>
      <body>
        <nav>Navigation item</nav>
        <main>
          <article>
            <h1>Article title</h1>
            <p>${"Useful article paragraph &amp; evidence. ".repeat(20)}</p>
          </article>
        </main>
        <footer>Footer content</footer>
      </body>
    </html>
  `
  const parsed = parseHtmlDocument(html)
  assert.equal(parsed.title, "Article title")
  assert.equal(parsed.publishedAt, "2026-07-19T10:00:00.000Z")
  assert.match(parsed.text, /Useful article paragraph & evidence/)
  assert.doesNotMatch(parsed.text, /Navigation item|do not expose|Footer content/)
})

test("extractPage returns final URL metadata and truncation state", () => {
  const html = Buffer.from(
    '<html><head><title>Test</title></head><body><main><p>1234567890</p></main></body></html>',
  )
  const page = extractPage(html, "text/html; charset=utf-8", "https://www.example.com/a", 5)
  assert.equal(page.domain, "example.com")
  assert.equal(page.title, "Test")
  assert.equal(page.text, "Test\n")
  assert.equal(page.truncated, true)
})

test("browse_page rejects local and private targets", () => {
  assert.throws(() => validatePublicUrl("http://localhost/test"), /not allowed/)
  assert.throws(() => validatePublicUrl("http://127.0.0.1/test"), /not allowed/)
  assert.throws(() => validatePublicUrl("http://10.2.3.4/test"), /not allowed/)
  assert.doesNotThrow(() => validatePublicUrl("https://example.com/path"))
  assert.equal(isForbiddenIp("169.254.1.2"), true)
  assert.equal(isForbiddenIp("8.8.8.8"), false)
})

test("browse_page accepts up to five unique URLs", () => {
  const input = normalizeBrowsePageInput({
    urls: ["https://example.com", "https://example.com", "https://example.org"],
    maxCharacters: 5000,
  })
  assert.deepEqual(input.urls, ["https://example.com", "https://example.org"])
  assert.equal(input.maxCharacters, 5000)
})

test("browse_page decompresses gzip responses with a bounded output", () => {
  const source = Buffer.from("<html><body>compressed page</body></html>")
  assert.deepEqual(decodeContentEncoding(zlib.gzipSync(source), "gzip"), source)
})

test("MCP tools/list exposes search and page reading", async () => {
  const response = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  assert.deepEqual(
    response.result.tools.map((tool) => tool.name),
    ["web_search", "browse_page"],
  )
})
