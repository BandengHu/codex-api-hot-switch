import "server-only"

import {
  executeBrowsePage,
  normalizeBrowsePageInput,
} from "../../../scripts/web-search-mcp/page-reader.cjs"
import {
  executeWebSearch,
  normalizeWebSearchInput,
} from "../../../scripts/web-search-mcp/search.cjs"

export const RELAY_WEB_SEARCH_TOOL_NAME = "web_search"
export const RELAY_BROWSE_PAGE_TOOL_NAME = "browse_page"

const HOSTED_WEB_SEARCH_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
])

type AnyRecord = Record<string, any>

interface StructuredSearchResult {
  title?: string
  url?: string
  domain?: string | null
  publishedAt?: string | null
  summary?: string
}

interface StructuredSearchResponse {
  query: string
  provider: "exa" | "parallel"
  resultCount: number
  results: StructuredSearchResult[]
  unparsedSummary?: string
}

interface BrowsePageResult {
  url?: string
  domain?: string | null
  title?: string
  publishedAt?: string | null
  contentType?: string
  content?: string
  truncated?: boolean
  error?: string
}

interface BrowsePageResponse {
  pageCount: number
  pages: BrowsePageResult[]
}

export type RelayWebToolName =
  | typeof RELAY_WEB_SEARCH_TOOL_NAME
  | typeof RELAY_BROWSE_PAGE_TOOL_NAME

export interface RelayWebToolInput {
  toolName: RelayWebToolName
  argumentsValue: unknown
  sessionId?: string
  modelName?: string
}

export interface RelayWebToolResult {
  toolName: RelayWebToolName
  text: string
  search?: StructuredSearchResponse
  browse?: BrowsePageResponse
}

const WEB_SEARCH_DESCRIPTION =
  "Search the public web for current information. Returns structured results with title, URL, publication date, source domain, and summary. Use browse_page on primary or independent sources before making important factual claims."

const BROWSE_PAGE_DESCRIPTION =
  "Open one or several public web pages and extract readable content with title, publication date, final URL, and source domain. Use this after web_search to inspect and cross-check sources."

const WEB_SEARCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "Web search query.",
    },
    numResults: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Number of search results to return. Defaults to 8.",
    },
    livecrawl: {
      type: "string",
      enum: ["fallback", "preferred"],
      description: "Whether live crawling is a fallback or preferred.",
    },
    type: {
      type: "string",
      enum: ["auto", "fast", "deep"],
      description: "Search depth: auto, fast, or deep.",
    },
    contextMaxCharacters: {
      type: "integer",
      minimum: 1,
      maximum: 200_000,
      description: "Maximum Exa context characters.",
    },
  },
  required: ["query"],
}

const BROWSE_PAGE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: {
      type: "string",
      description: "One public HTTP or HTTPS URL to open.",
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
      description: "Timeout in seconds. Defaults to 30.",
    },
    maxCharacters: {
      type: "integer",
      minimum: 1000,
      maximum: 100_000,
      description: "Maximum content characters per page. Defaults to 20000.",
    },
  },
  required: ["url"],
}

function responseFunctionTool(
  name: RelayWebToolName,
  description: string,
  parameters: AnyRecord,
) {
  return {
    type: "function",
    name,
    description,
    parameters,
  }
}

export function relayWebSearchResponsesTools() {
  return [
    responseFunctionTool(
      RELAY_WEB_SEARCH_TOOL_NAME,
      WEB_SEARCH_DESCRIPTION,
      WEB_SEARCH_PARAMETERS,
    ),
    responseFunctionTool(
      RELAY_BROWSE_PAGE_TOOL_NAME,
      BROWSE_PAGE_DESCRIPTION,
      BROWSE_PAGE_PARAMETERS,
    ),
  ]
}

export function relayWebSearchChatTools() {
  return relayWebSearchResponsesTools().map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}

export function isHostedWebSearchToolType(type: unknown): boolean {
  return typeof type === "string" && HOSTED_WEB_SEARCH_TOOL_TYPES.has(type.trim())
}

export function supportsRelayWebSearchProvider(
  provider: { protocol?: string; rawResponsesPassthrough?: boolean } | undefined,
) {
  if (!provider) return false
  return !(provider.protocol === "openai-responses" && provider.rawResponsesPassthrough === true)
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function displayDate(value: unknown) {
  return text(value) || "unknown"
}

export function formatSearchToolOutput(result: StructuredSearchResponse) {
  const lines = [
    `Search query: ${result.query}`,
    `Provider: ${result.provider}`,
    `Results: ${result.resultCount}`,
  ]
  result.results.forEach((item, index) => {
    lines.push(
      "",
      `### ${index + 1}. ${text(item.title) || text(item.domain) || "Untitled source"}`,
      `URL: ${text(item.url)}`,
      `Source: ${text(item.domain) || "unknown"}`,
      `Published: ${displayDate(item.publishedAt)}`,
    )
    if (text(item.summary)) lines.push(`Summary: ${text(item.summary)}`)
  })
  if (!result.results.length) {
    lines.push("", result.unparsedSummary || "No search results found. Try a different query.")
  }
  return lines.join("\n")
}

export function formatBrowseToolOutput(result: BrowsePageResponse) {
  const lines = [`Pages read: ${result.pageCount}/${result.pages.length}`]
  result.pages.forEach((page, index) => {
    lines.push(
      "",
      `## Page ${index + 1}: ${text(page.title) || text(page.domain) || "Unreadable page"}`,
      `URL: ${text(page.url)}`,
    )
    if (page.error) {
      lines.push(`Error: ${page.error}`)
      return
    }
    lines.push(
      `Source: ${text(page.domain) || "unknown"}`,
      `Published: ${displayDate(page.publishedAt)}`,
      `Content-Type: ${text(page.contentType) || "unknown"}`,
      `Truncated: ${page.truncated === true ? "yes" : "no"}`,
      "",
      text(page.content),
    )
  })
  return lines.join("\n")
}

export async function executeRelayWebTool(
  input: RelayWebToolInput,
  signal?: AbortSignal,
): Promise<RelayWebToolResult> {
  if (input.toolName === RELAY_WEB_SEARCH_TOOL_NAME) {
    const argumentsValue = {
      ...(input.argumentsValue && typeof input.argumentsValue === "object"
        ? input.argumentsValue as AnyRecord
        : {}),
      sessionId: input.sessionId,
      modelName: input.modelName,
    }
    const search = await executeWebSearch(
      normalizeWebSearchInput(argumentsValue),
      signal,
    ) as StructuredSearchResponse
    return {
      toolName: input.toolName,
      search,
      text: formatSearchToolOutput(search),
    }
  }

  const browse = await executeBrowsePage(
    normalizeBrowsePageInput(input.argumentsValue),
    signal,
  )
  return {
    toolName: input.toolName,
    browse,
    text: formatBrowseToolOutput(browse),
  }
}
