import { searchWeb } from "@/lib/server/web"
import { WebSearchError, webToolError } from "@/lib/server/web/errors"
import type { WebSearchResponse, WebSearchResult } from "@/lib/server/web/types"

type AnyRecord = Record<string, any>

const MAX_RESULT_LIMIT = 20

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is AnyRecord => isObject(part) && part.type === "text")
    .map((part) => text(part.text))
    .filter(Boolean)
    .join("\n")
    .trim()
}

function lastUserMessageText(body: unknown): string {
  if (!isObject(body) || !Array.isArray(body.messages)) {
    throw new WebSearchError("DSH Messages 请求缺少 messages", {
      code: "WEB_INVALID_REQUEST",
      retryable: false,
      provider: "switchgate-dsh",
      status: 400,
    })
  }

  const userMessages = body.messages
    .filter((message): message is AnyRecord => isObject(message) && message.role === "user")
    .map((message) => contentText(message.content))
    .filter(Boolean)
  const query = userMessages.at(-1) || ""
  if (!query) {
    throw new WebSearchError("DSH Messages 请求缺少可搜索文本", {
      code: "WEB_INVALID_REQUEST",
      retryable: false,
      provider: "switchgate-dsh",
      status: 400,
    })
  }

  return query
}

export function extractDshSearchQueries(body: unknown): string[] {
  const queryText = lastUserMessageText(body)
  const matches = [...queryText.matchAll(
    /(?:perform|do)\s+a\s+web\s+search\s+for\s+the\s+query:\s*([^\r\n]+)/giu,
  )]
  const queries = (matches.length > 0 ? matches.map((match) => match[1]) : [queryText])
    .map((value) => text(value))
    .filter(Boolean)
  const unique = [...new Set(queries)]
  if (unique.length > 0) return unique
  throw new WebSearchError("DSH Messages 请求缺少可搜索文本", {
    code: "WEB_INVALID_REQUEST",
    retryable: false,
    provider: "switchgate-dsh",
    status: 400,
  })
}

export function extractDshSearchQuery(body: unknown): string {
  return extractDshSearchQueries(body)[0] || ""
}

function positiveLimit(value: unknown): number | undefined {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return Math.max(1, Math.min(MAX_RESULT_LIMIT, Math.trunc(number)))
}

export function resolveDshSearchLimit(body: unknown): number {
  if (!isObject(body)) return MAX_RESULT_LIMIT
  for (const value of [body.max_results, body.maxResults, body.searchMaxResults]) {
    const limit = positiveLimit(value)
    if (limit !== undefined) return limit
  }
  return MAX_RESULT_LIMIT
}

function sourceItem(result: WebSearchResult) {
  return {
    type: "web_search_result",
    url: result.url,
    ...(result.title ? { title: result.title } : {}),
    ...(result.publishedAt ? { page_age: result.publishedAt } : {}),
  }
}

function citationText(
  result: WebSearchResult,
  group: WebSearchResponse["groups"][number],
  index: number,
): string {
  const query = result.query ? `query=${result.query}; ` : ""
  const position = `result=${index + 1}/${group.total}; more=${group.hasMore}; `
  const score = `score=${result.score.toFixed(2)} (relative)`
  const summary = result.summary || result.title
  return `${query}${position}${score}; ${summary}`.slice(0, 500)
}

function citations(
  groups: WebSearchResponse["groups"],
) {
  return groups.flatMap((group) => group.results.map((result, index) => ({
    type: "web_search_result_location",
    url: result.url,
    cited_text: citationText(result, group, index),
  })))
}

function groupText(group: WebSearchResponse["groups"][number]): string {
  const shown = group.results.length
  const total = group.total
  const availability = group.hasMore
    ? `Showing ${shown} of ${total}; more results are available.`
    : `Showing ${shown} result${shown === 1 ? "" : "s"}.`
  const lines = group.results
    .filter((result) => result.summary || result.title)
    .map((result) => {
      const score = result.score.toFixed(2)
      return `- [${result.title}](${result.url}) — score=${score} (relative); ${result.summary || result.title}`
    })
  return [
    `Query: ${group.query}`,
    availability,
    "Scores are relative within this query and are not comparable across queries.",
    ...(group.answer ? [`Summary: ${group.answer}`] : []),
    ...(lines.length > 0 ? lines : ["No search results found."]),
  ].join("\n")
}

function resultText(response: WebSearchResponse): string {
  const groups = response.groups.map(groupText)
  const errors = response.errors.map((error) =>
    `Query ${error.query || "(unknown)"} failed: ${error.code} — ${error.message}`,
  )
  return [...groups, ...errors].join("\n\n") || "No search results found."
}

export function buildDshSearchResponse(
  body: unknown,
  searchResponse: WebSearchResponse,
) {
  const results = searchResponse.groups.flatMap((group) => group.results)
  const model = isObject(body) && text(body.model)
    ? text(body.model)
    : "switchgate-web-search"
  const content = [
    ...searchResponse.groups.map((group) => ({
      type: "web_search_tool_result",
      content: group.results.map(sourceItem),
    })),
    {
      type: "text",
      text: resultText(searchResponse),
      citations: citations(searchResponse.groups),
    },
  ]

  return {
    id: `msg_switchgate_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  }
}

export async function executeDshSearchMessages(
  body: unknown,
  signal?: AbortSignal,
) {
  const queries = extractDshSearchQueries(body)
  const response = await searchWeb(
    {
      queries: queries.map((query) => ({ query })),
      limit: resolveDshSearchLimit(body),
      answer: true,
    },
    signal,
  )
  const hasResults = response.groups.some((group) => group.results.length > 0)
  if (!hasResults && response.errors.length > 0) {
    const error = response.errors[response.errors.length - 1]
    throw new WebSearchError(error.message, {
      code: error.code,
      retryable: error.retryable,
      provider: "switchgate-dsh",
      status: error.status,
    })
  }
  return buildDshSearchResponse(body, response)
}

export function dshSearchErrorResponse(error: unknown) {
  const normalized = webToolError(error, "switchgate-dsh")
  const status = error instanceof WebSearchError && error.status
    ? error.status
    : normalized.code === "WEB_INVALID_REQUEST"
      ? 400
      : 502
  return Response.json(
    {
      type: "error",
      error: {
        type: normalized.retryable ? "api_error" : "invalid_request_error",
        message: normalized.message,
      },
    },
    {
      status,
      headers: {
        "cache-control": "no-store",
      },
    },
  )
}
