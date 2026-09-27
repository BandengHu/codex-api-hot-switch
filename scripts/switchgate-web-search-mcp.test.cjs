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
  executeWebSearch,
  normalizeWebSearchInput,
} = require("./web-search-mcp/search.cjs")
const { handleRequest } = require("./web-search-mcp/server.cjs")

test("normalizes one or several web queries for the local API", () => {
  assert.deepEqual(normalizeWebSearchInput({
    queries: [
      { query: "SwitchGate", domains: ["example.com"], language: "zh" },
      { query: "Codex", recencyDays: 7 },
    ],
    limit: 5,
    answer: true,
    includeContent: true,
  }), {
    queries: [
      { query: "SwitchGate", domains: ["example.com"], language: "zh" },
      { query: "Codex", recencyDays: 7 },
    ],
    limit: 5,
    answer: true,
    includeContent: true,
  })
})

test("MCP 搜索只转发本地 Web API 并保留结构化结果", async () => {
  const originalFetch = global.fetch
  let request
  try {
    global.fetch = async (url, options) => {
      request = { url, options }
      return new Response(JSON.stringify({
        groups: [{ query: "SwitchGate", total: 0, limit: 8, hasMore: false, provider: "switchgate", capabilities: {}, results: [] }],
        errors: [],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    const result = await executeWebSearch(normalizeWebSearchInput({
      query: "SwitchGate",
      limit: 2,
      answer: true,
      includeContent: true,
    }))
    assert.equal(result.groups[0].query, "SwitchGate")
    assert.match(request.url, /api\/web-search$/)
    assert.deepEqual(JSON.parse(request.options.body), {
      operation: "search",
      queries: [{ query: "SwitchGate" }],
      limit: 2,
      answer: true,
      includeContent: true,
    })
  } finally {
    global.fetch = originalFetch
  }
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
  assert.equal(page.content, "Test\n")
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
    format: "text",
    timeout: 45,
  })
  assert.deepEqual(input.urls, ["https://example.com", "https://example.org"])
  assert.equal(input.maxCharacters, 5000)
  assert.equal(input.format, "text")
  assert.equal(input.timeoutSeconds, 45)
})

test("browse_page extracts markdown links and supports html output", () => {
  const html = Buffer.from(`
    <html>
      <head><title>Official page</title></head>
      <body>
        <main>
          <h1>Official page</h1>
          <p>Read <a href="https://example.com/docs">the documentation</a>.</p>
          <ul><li>First item</li><li>Second item</li></ul>
        </main>
      </body>
    </html>
  `)
  const markdown = extractPage(
    html,
    "text/html; charset=utf-8",
    "https://example.com",
    5000,
    "markdown",
  )
  assert.match(markdown.content, /\[the documentation\]\(https:\/\/example\.com\/docs\)/)
  assert.match(markdown.content, /- First item/)

  const rawHtml = extractPage(
    html,
    "text/html; charset=utf-8",
    "https://example.com",
    5000,
    "html",
  )
  assert.match(rawHtml.content, /<h1>Official page<\/h1>/)
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
  assert.equal(response.result.tools[0].inputSchema.properties.provider, undefined)
  assert.equal(response.result.tools[0].inputSchema.properties.answer.type, "boolean")
  assert.equal(response.result.tools[0].inputSchema.properties.includeContent.type, "boolean")
  assert.deepEqual(response.result.tools[1].inputSchema.properties.format.enum, [
    "markdown",
    "text",
    "html",
  ])
})
