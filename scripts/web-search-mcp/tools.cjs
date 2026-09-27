"use strict"

const { randomUUID } = require("node:crypto")
const { normalizeBrowsePageInput } = require("./page-reader.cjs")
const { postWebApi } = require("./api-client.cjs")
const { executeWebSearch, normalizeWebSearchInput } = require("./search.cjs")

const WEB_SEARCH_TOOL_NAME = "web_search"
const BROWSE_PAGE_TOOL_NAME = "browse_page"
const MCP_SESSION_ID = randomUUID()

const TOOL_DEFINITIONS = [
  {
    name: WEB_SEARCH_TOOL_NAME,
    description:
      "Search the public web and return grouped structured results with title, URL, publication date, source domain, summary, relative ranking score, and capability metadata. Scores are comparable only within one query. Set answer=true for an extractive answer, or includeContent=true to inline bounded Markdown from up to five top results. For important factual claims, follow the search with browse_page on at least two independent or official sources.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "One search query." },
        queries: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              query: { type: "string" },
              recencyDays: { type: "integer", minimum: 1, maximum: 3650 },
              domains: { type: "array", items: { type: "string" }, maxItems: 20 },
              language: { type: "string" },
            },
            required: ["query"],
          },
          description: "Optional grouped queries.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Results per query.",
        },
        answer: {
          type: "boolean",
          description: "Include a short extractive answer assembled from returned sources.",
        },
        includeContent: {
          type: "boolean",
          description: "Inline bounded Markdown from up to five top results.",
        },
      },
      anyOf: [{ required: ["query"] }, { required: ["queries"] }],
    },
  },
  {
    name: BROWSE_PAGE_TOOL_NAME,
    description:
      "Open one or several public web pages and extract readable page text, title, publication date, final URL, and source domain. Use multiple URLs from web_search to cross-check important claims; prefer primary and official sources.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "One public HTTP or HTTPS URL to open." },
        urls: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string" },
          description: "Up to five public URLs to open and compare in one call.",
        },
        maxCharacters: {
          type: "integer",
          minimum: 1000,
          maximum: 100000,
          description: "Maximum extracted text characters per page. Defaults to 20000.",
        },
        format: {
          type: "string",
          enum: ["markdown", "text", "html"],
          description: "Output format. Defaults to markdown.",
        },
        timeout: {
          type: "number",
          minimum: 1,
          maximum: 120,
          description: "Request timeout in seconds, up to 120.",
        },
      },
      anyOf: [{ required: ["url"] }, { required: ["urls"] }],
    },
  },
]

async function executeTool(name, argumentsValue, signal) {
  if (name === WEB_SEARCH_TOOL_NAME) {
    return await executeWebSearch(
      normalizeWebSearchInput({
        ...(argumentsValue && typeof argumentsValue === "object" ? argumentsValue : {}),
        sessionId: MCP_SESSION_ID,
      }),
      signal,
    )
  }
  if (name === BROWSE_PAGE_TOOL_NAME) {
    return postWebApi("browse", normalizeBrowsePageInput(argumentsValue), signal)
  }
  throw new Error(`Unknown tool: ${name || "(missing)"}`)
}

module.exports = {
  BROWSE_PAGE_TOOL_NAME,
  TOOL_DEFINITIONS,
  WEB_SEARCH_TOOL_NAME,
  executeTool,
}
