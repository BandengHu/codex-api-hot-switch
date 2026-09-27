import "server-only"

import { browseWebPages, searchWeb } from "../web"
import type { BrowsePageResponse, WebSearchResponse } from "../web"

export const RELAY_WEB_SEARCH_TOOL_NAME = "web_search"
export const RELAY_BROWSE_PAGE_TOOL_NAME = "browse_page"

const HOSTED_WEB_SEARCH_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "web_search_preview_2025_03_11",
])

type AnyRecord = Record<string, any>

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
  search?: WebSearchResponse
  browse?: BrowsePageResponse
}

const WEB_SEARCH_DESCRIPTION =
  "Search the public web for current information. It supports one query or grouped queries, returns title, URL, publication date, source domain, summary, score, total, and provider errors. Use browse_page on official or independent sources before important factual claims."

const BROWSE_PAGE_DESCRIPTION =
  "Open one or several public web pages and extract readable content with title, publication date, final URL, source domain, and bounded content. Use this after web_search to inspect and cross-check sources."

const WEB_SEARCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "One web search query." },
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
      description: "Optional grouped queries. Each query is returned in its own group.",
    },
    limit: { type: "integer", minimum: 1, maximum: 20, description: "Results per query. Defaults to 8." },
    numResults: { type: "integer", minimum: 1, maximum: 20, description: "Alias for limit." },
  },
  anyOf: [{ required: ["query"] }, { required: ["queries"] }],
}

const BROWSE_PAGE_PARAMETERS = {
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
  anyOf: [{ required: ["url"] }, { required: ["urls"] }],
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

function number(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback
}

function normalizeSearchRequest(value: unknown) {
  const record = value && typeof value === "object" ? value as AnyRecord : {}
  const rawQueries = Array.isArray(record.queries)
    ? record.queries.filter((item) => item && typeof item === "object") as AnyRecord[]
    : [{ query: record.query || record.q || record.search_query || record.input }]
  const queries = rawQueries.map((item) => ({
    query: text(item.query),
    ...(Number.isFinite(Number(item.recencyDays))
      ? { recencyDays: number(item.recencyDays, 1, 1, 3650) }
      : {}),
    ...(Array.isArray(item.domains)
      ? { domains: item.domains.map(text).filter(Boolean).slice(0, 20) }
      : {}),
    ...(text(item.language) ? { language: text(item.language) } : {}),
  })).filter((item) => item.query)
  if (!queries.length) throw new Error("web_search requires query or queries")
  return {
    queries,
    limit: number(record.limit ?? record.numResults, 8, 1, 20),
  }
}

export function formatSearchToolOutput(result: WebSearchResponse) {
  const lines: string[] = []
  for (const group of result.groups) {
    lines.push(
      `Search query: ${group.query}`,
      `Provider: ${group.provider}`,
      `Total: ${group.total}`,
      `Limit: ${group.limit}`,
      `Has more: ${group.hasMore}`,
    )
    group.results.forEach((item, index) => {
      lines.push(
        "",
        `### ${index + 1}. ${item.title}`,
        `URL: ${item.url}`,
        `Source: ${item.domain || "unknown"}`,
        `Published: ${item.publishedAt ?? "null"}`,
        `Score: ${item.score}`,
        `Summary: ${item.summary}`,
      )
    })
    if (group.error) lines.push("", `Error: ${JSON.stringify(group.error)}`)
  }
  for (const error of result.errors) lines.push("", `Search error: ${JSON.stringify(error)}`)
  return lines.join("\n") || "No search results found."
}

export function formatBrowseToolOutput(result: BrowsePageResponse) {
  const lines = [`Pages read: ${result.pageCount}/${result.pages.length}`]
  result.pages.forEach((page, index) => {
    lines.push(
      "",
      `## Page ${index + 1}: ${text(page.title) || text(page.domain) || "Unreadable page"}`,
      `URL: ${text(page.finalUrl || page.url)}`,
    )
    if (page.error) {
      lines.push(`Error: ${page.error}`)
      return
    }
    lines.push(
      `Source: ${text(page.domain) || "unknown"}`,
      `Published: ${page.publishedAt ?? "null"}`,
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
    const search = await searchWeb(normalizeSearchRequest(input.argumentsValue), signal)
    return {
      toolName: input.toolName,
      search,
      text: formatSearchToolOutput(search),
    }
  }

  const browse = await browseWebPages(input.argumentsValue, signal)
  return {
    toolName: input.toolName,
    browse,
    text: formatBrowseToolOutput(browse),
  }
}
