import { createHash } from "node:crypto"
import { readSearchCache, writeSearchCache } from "./cache"
import { WebSearchError, classifyHttpError, isAbortError, throwIfAborted, webToolError } from "./errors"
import { browseWebPages } from "./page"
import {
  compactWhitespace,
  dedupeResults,
  domainFromUrl,
  filterLowConfidenceResults,
  isBlockedPage,
  normalizePublishedAt,
  normalizeScore,
  normalizeTitle,
  normalizeUrl,
  relevantSummary,
} from "./normalize"
import {
  DEFAULT_SEARCH_CAPABILITIES,
  type SearchCapabilities,
  type WebSearchGroup,
  type WebSearchQuery,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
  type WebToolError,
} from "./types"

type RawResult = Record<string, unknown>

interface ProviderResult {
  provider: string
  results: RawResult[]
}

interface SearchProvider {
  id: string
  available: boolean
  search(query: WebSearchQuery, signal?: AbortSignal): Promise<ProviderResult>
}

interface SearchGroupOptions {
  answer: boolean
  includeContent: boolean
}

const EXA_URL = "https://mcp.exa.ai/mcp"
const PARALLEL_URL = "https://search.parallel.ai/mcp"
const DEFAULT_TIMEOUT_MS = 25_000
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_INLINE_CONTENT_RESULTS = 5
const MAX_INLINE_CONTENT_CHARS = 8_000

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function timeoutSignal(signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    },
  }
}

async function readText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("web_search 响应超过大小限制")
    }
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!next.value) continue
      total += next.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error("web_search 响应超过大小限制")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function jsonPayloads(body: string): Record<string, unknown>[] {
  const payloads: Record<string, unknown>[] = []
  const candidates = [body.trim(), ...body.split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())]
  for (const candidate of candidates) {
    if (!candidate || candidate === "[DONE]") continue
    try {
      const parsed = JSON.parse(candidate)
      if (object(parsed)) payloads.push(parsed)
    } catch {
      // The provider may return a labelled text payload. It is parsed below.
    }
  }
  return payloads
}

function resultText(payload: Record<string, unknown>, provider: string): string {
  const rpcError = object(payload.error) ? payload.error : null
  if (rpcError) {
    const message = compactWhitespace(rpcError.message) || "搜索 provider 返回 JSON-RPC error"
    throw new WebSearchError(message, {
      code: "WEB_PROVIDER_RPC_ERROR",
      retryable: true,
      provider,
    })
  }
  const result = object(payload.result) ? payload.result : payload
  if (result.isError === true) {
    const content = Array.isArray(result.content) ? result.content : []
    const message = content
      .filter((item) => object(item) && typeof item.text === "string")
      .map((item) => compactWhitespace(item.text))
      .filter(Boolean)
      .join("\n") || "搜索 provider 返回业务错误"
    throw new WebSearchError(message, {
      code: "WEB_PROVIDER_RESULT_ERROR",
      retryable: true,
      provider,
    })
  }
  const content = Array.isArray(result.content) ? result.content : []
  const texts = content
    .filter((item) => object(item) && typeof item.text === "string")
    .map((item) => item.text as string)
    .filter((text) => text.trim())
  if (texts.length) return texts.join("\n")
  if (typeof result.output === "string") return result.output
  if (typeof result.text === "string") return result.text
  return ""
}

function parseRawResults(text: string): RawResult[] {
  const trimmed = text.trim()
  const candidates: unknown[] = []
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      candidates.push(JSON.parse(trimmed))
    } catch {
      // Continue with labelled/markdown parsing.
    }
  }
  const results: RawResult[] = []
  const walk = (value: unknown, depth = 0) => {
    if (depth > 6 || value === null || value === undefined) return
    if (Array.isArray(value)) {
      for (const item of value) {
        if (object(item) && (item.url || item.link || item.href)) results.push(item)
        else walk(item, depth + 1)
      }
      return
    }
    if (!object(value)) return
    for (const key of ["results", "items", "sources", "documents", "organic", "data"]) {
      if (key in value) walk(value[key], depth + 1)
    }
  }
  for (const candidate of candidates) walk(candidate)
  if (!results.length) {
    const blocks = trimmed.split(/\r?\n---\r?\n/u)
    for (const block of blocks) {
      const url = block.match(/(?:^|\n)URL:\s*(https?:\/\/\S+)/iu)?.[1]
      if (!url) continue
      results.push({
        url,
        title: block.match(/(?:^|\n)Title:\s*(.+)/iu)?.[1],
        publishedAt: block.match(/(?:^|\n)Published:\s*(.+)/iu)?.[1],
        summary: block.match(/(?:^|\n)Highlights?:\s*([\s\S]*)/iu)?.[1],
      })
    }
  }
  if (!results.length) {
    const pattern = /\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)/gu
    for (const match of trimmed.matchAll(pattern)) {
      results.push({ title: match[1], url: match[2] })
    }
  }
  return results
}

async function callMcp(
  provider: string,
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = timeoutSignal(signal)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: timeout.signal,
      })
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw new WebSearchError(`${provider} 搜索超时或已取消`, {
          code: signal?.aborted ? "WEB_ABORTED" : "WEB_PROVIDER_TIMEOUT",
          retryable: !signal?.aborted,
          provider,
        })
      }
      throw new WebSearchError(`${provider} 搜索网络请求失败：${String(error)}`, {
        code: "WEB_PROVIDER_NETWORK",
        retryable: true,
        provider,
        cause: error,
      })
    }
    const text = await readText(response)
    if (!response.ok) throw classifyHttpError(provider, response.status, text)
    const payloads = jsonPayloads(text)
    if (!payloads.length) {
      throw new WebSearchError(`${provider} 返回不可解析的搜索响应`, {
        code: "WEB_PROVIDER_INVALID_RESPONSE",
        retryable: true,
        provider,
      })
    }
    for (const payload of payloads) {
      const content = resultText(payload, provider)
      if (content) return content
    }
    throw new WebSearchError(`${provider} 返回空搜索内容`, {
      code: "WEB_PROVIDER_EMPTY_RESPONSE",
      retryable: true,
      provider,
    })
  } finally {
    timeout.done()
  }
}

function exaProvider(): SearchProvider {
  return {
    id: "exa",
    available: true,
    async search(query, signal) {
      const apiKey = process.env.EXA_API_KEY?.trim()
      const url = new URL(EXA_URL)
      if (apiKey) url.searchParams.set("exaApiKey", apiKey)
      const text = await callMcp(
        "exa",
        url.toString(),
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: {
              query: query.query,
              type: "auto",
              numResults: 20,
              ...(query.domains?.length ? { includeDomains: query.domains } : {}),
              ...(query.recencyDays ? {
                startPublishedDate: new Date(Date.now() - query.recencyDays * 86400000).toISOString(),
              } : {}),
            },
          },
        },
        { accept: "application/json, text/event-stream", "content-type": "application/json" },
        signal,
      )
      return { provider: "exa", results: parseRawResults(text) }
    },
  }
}

function parallelProvider(): SearchProvider {
  return {
    id: "parallel",
    available: Boolean(process.env.PARALLEL_API_KEY?.trim()),
    async search(query, signal) {
      const text = await callMcp(
        "parallel",
        PARALLEL_URL,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search",
            arguments: {
              objective: query.query,
              search_queries: [query.query],
            },
          },
        },
        {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          authorization: `Bearer ${process.env.PARALLEL_API_KEY?.trim()}`,
        },
        signal,
      )
      return { provider: "parallel", results: parseRawResults(text) }
    },
  }
}

function duckDuckGoProvider(): SearchProvider {
  return {
    id: "duckduckgo",
    available: true,
    async search(query, signal) {
      const timeout = timeoutSignal(signal)
      try {
        const url = new URL("https://html.duckduckgo.com/html/")
        url.searchParams.set("q", query.query)
        const response = await fetch(url, {
          headers: { accept: "text/html", "user-agent": "Mozilla/5.0 SwitchGate" },
          signal: timeout.signal,
        })
        const text = await readText(response)
        if (!response.ok) throw classifyHttpError("duckduckgo", response.status, text)
        const results: RawResult[] = []
        const pattern = /result__a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?result__snippet[^>]*>([\s\S]*?)<\/a>/giu
        for (const match of text.matchAll(pattern)) {
          results.push({
            url: match[1],
            title: match[2].replace(/<[^>]+>/gu, " "),
            summary: match[3].replace(/<[^>]+>/gu, " "),
          })
        }
        if (!results.length) {
          throw new WebSearchError("DuckDuckGo 返回无可解析结果", {
            code: "WEB_PROVIDER_INVALID_RESPONSE",
            retryable: true,
            provider: "duckduckgo",
          })
        }
        return { provider: "duckduckgo", results }
      } finally {
        timeout.done()
      }
    },
  }
}

function providers(): SearchProvider[] {
  return [exaProvider(), parallelProvider(), duckDuckGoProvider()].filter((provider) => provider.available)
}

function capabilities(query: WebSearchQuery): SearchCapabilities {
  return {
    ...DEFAULT_SEARCH_CAPABILITIES,
    ...(query.language ? { language: "query" } : {}),
  }
}

function normalizeProviderResults(provider: ProviderResult, query: WebSearchQuery): WebSearchResult[] {
  const total = provider.results.length
  return provider.results.map((raw, index) => {
    const url = normalizeUrl(raw.url || raw.link || raw.href)
    const summary = relevantSummary(
      raw.summary || raw.snippet || raw.description || raw.content || raw.text,
      query.query,
    )
    const title = normalizeTitle(raw.title || raw.name || raw.headline, url, summary)
    return {
      query: query.query,
      title,
      url,
      domain: domainFromUrl(url),
      summary,
      score: normalizeScore(raw.score, index, total, query.query, `${title} ${summary}`),
      publishedAt: normalizePublishedAt(raw.publishedAt || raw.published_at || raw.published || raw.date),
      provider: provider.provider,
    }
  }).filter((result) => result.url && !isBlockedPage(result.title, result.summary, result.url))
}

async function addInlineContent(
  results: WebSearchResult[],
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const targets = results.slice(0, MAX_INLINE_CONTENT_RESULTS)
  if (!targets.length) return results
  try {
    const response = await browseWebPages(
      {
        urls: targets.map((result) => result.url),
        format: "markdown",
        maxCharacters: MAX_INLINE_CONTENT_CHARS,
      },
      signal,
    )
    const pages = new Map<string, (typeof response.pages)[number]>()
    for (const page of response.pages) {
      pages.set(normalizeUrl(page.url), page)
      if (page.finalUrl) pages.set(normalizeUrl(page.finalUrl), page)
    }
    return results.map((result) => {
      const page = pages.get(normalizeUrl(result.url))
      if (!page || !page.content || page.error) return result
      return {
        ...result,
        ...(page.finalUrl ? { finalUrl: page.finalUrl } : {}),
        ...(page.contentType ? { contentType: page.contentType } : {}),
        ...(page.title && result.title.length < 3 ? { title: page.title } : {}),
        ...(result.publishedAt === null && page.publishedAt !== undefined
          ? { publishedAt: page.publishedAt ?? null }
          : {}),
        content: page.content,
        ...(page.truncated === undefined ? {} : { contentTruncated: page.truncated }),
      }
    })
  } catch {
    throwIfAborted(signal)
    return results
  }
}

function cacheKey(request: WebSearchRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex")
}

async function searchGroup(
  query: WebSearchQuery,
  limit: number,
  options: SearchGroupOptions,
  signal?: AbortSignal,
): Promise<WebSearchGroup> {
  const errors: WebToolError[] = []
  let successfulProvider: string | null = null
  for (const provider of providers()) {
    throwIfAborted(signal)
    try {
      const normalized = normalizeProviderResults(
        await provider.search(query, signal),
        query,
      )
      successfulProvider ??= provider.id
      const result = dedupeResults(filterLowConfidenceResults(normalized, query.query))
        .sort((left, right) => right.score - left.score)
      if (result.length === 0) continue
      const selected = options.includeContent
        ? await addInlineContent(result.slice(0, limit), signal)
        : result.slice(0, limit)
      return {
        query: query.query,
        total: result.length,
        limit,
        hasMore: result.length > limit,
        provider: provider.id,
        capabilities: capabilities(query),
        results: selected,
        scoreBasis: "relative",
        ...(options.answer
          ? { answer: extractiveAnswer({ results: selected }) }
          : {}),
      }
    } catch (error) {
      const structured = webToolError(error, provider.id)
      errors.push(structured)
      if (!structured.retryable) break
    }
  }
  if (successfulProvider) {
    return {
      query: query.query,
      total: 0,
      limit,
      hasMore: false,
      provider: successfulProvider,
      capabilities: capabilities(query),
      results: [],
      scoreBasis: "relative",
      ...(options.answer ? { answer: "" } : {}),
    }
  }
  const last = errors[errors.length - 1] ?? {
    code: "WEB_PROVIDER_UNAVAILABLE",
    message: "没有可用的网页搜索 provider",
    retryable: true,
    provider: "switchgate",
  }
  return {
    query: query.query,
    total: 0,
    limit,
    hasMore: false,
    provider: last.provider,
    capabilities: capabilities(query),
    results: [],
    scoreBasis: "relative",
    error: last,
  }
}

export async function searchWeb(
  request: WebSearchRequest,
  signal?: AbortSignal,
): Promise<WebSearchResponse> {
  const queries = (Array.isArray(request.queries) ? request.queries : [])
    .map((query) => ({
      ...query,
      query: typeof query.query === "string" ? query.query.trim() : "",
    }))
    .filter((query) => query.query)
  const requestedLimit = Number(request.limit)
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(20, Math.trunc(requestedLimit)))
    : 8
  if (!queries.length) {
    throw new WebSearchError("web_search 至少需要一个查询", {
      code: "WEB_INVALID_REQUEST",
      retryable: false,
      provider: "switchgate",
    })
  }
  const normalizedRequest = {
    queries,
    limit,
    ...(request.answer === true ? { answer: true } : {}),
    ...(request.includeContent === true ? { includeContent: true } : {}),
  }
  const key = cacheKey(normalizedRequest)
  const cached = readSearchCache<WebSearchResponse>(key)
  if (cached) return cached
  const groups = await Promise.all(queries.map((query) => searchGroup(
    query,
    limit,
    {
      answer: request.answer === true,
      includeContent: request.includeContent === true,
    },
    signal,
  )))
  const response = {
    groups,
    errors: groups.flatMap((group) => group.error
      ? [{ ...group.error, query: group.query }]
      : []),
  }
  writeSearchCache(key, response)
  return response
}

export function extractiveAnswer(group: Pick<WebSearchGroup, "results">): string {
  const selected = group.results
    .filter((result) => result.summary || result.content)
    .slice(0, 3)
    .map((result) => {
      const source = result.summary || compactWhitespace(result.content).slice(0, 280)
      return `${source} [${result.title}](${result.url})`
    })
  return selected.join("\n\n")
}
