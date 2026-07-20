"use strict"

const { executeBrowsePage, normalizeBrowsePageInput } = require("./page-reader.cjs")
const { executeWebSearch, normalizeWebSearchInput } = require("./search.cjs")

const WEB_SEARCH_TOOL_NAME = "web_search"
const BROWSE_PAGE_TOOL_NAME = "browse_page"

const TOOL_DEFINITIONS = [
  {
    name: WEB_SEARCH_TOOL_NAME,
    description:
      "Search the public web and return structured results with title, URL, publication date, source domain, and summary. For important factual claims, follow the search with browse_page on at least two independent or official sources.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "The search query." },
        provider: {
          type: "string",
          enum: ["auto", "exa", "parallel"],
          description: "Optional search backend override.",
        },
        numResults: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of results.",
        },
        type: {
          type: "string",
          enum: ["auto", "fast", "deep"],
          description: "Exa search depth.",
        },
        livecrawl: {
          type: "string",
          enum: ["fallback", "preferred"],
          description: "Exa live crawl preference.",
        },
        contextMaxCharacters: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description: "Optional Exa context character budget.",
        },
        sessionId: { type: "string", description: "Optional Parallel session id." },
        modelName: { type: "string", description: "Optional Parallel model name hint." },
      },
      required: ["query"],
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
      },
      anyOf: [{ required: ["url"] }, { required: ["urls"] }],
    },
  },
]

async function executeTool(name, argumentsValue, signal) {
  if (name === WEB_SEARCH_TOOL_NAME) {
    return await executeWebSearch(normalizeWebSearchInput(argumentsValue), signal)
  }
  if (name === BROWSE_PAGE_TOOL_NAME) {
    return await executeBrowsePage(normalizeBrowsePageInput(argumentsValue), signal)
  }
  throw new Error(`Unknown tool: ${name || "(missing)"}`)
}

module.exports = {
  BROWSE_PAGE_TOOL_NAME,
  TOOL_DEFINITIONS,
  WEB_SEARCH_TOOL_NAME,
  executeTool,
}
