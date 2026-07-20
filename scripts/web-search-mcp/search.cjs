"use strict"

const {
  cleanPositiveInteger,
  cleanString,
  compactWhitespace,
  domainFromUrl,
  isObject,
  normalizePublishedAt,
  readFetchResponseText,
  timeoutMs,
  withTimeout,
} = require("./shared.cjs")

const EXA_WEB_SEARCH_URL = "https://mcp.exa.ai/mcp"
const PARALLEL_WEB_SEARCH_URL = "https://search.parallel.ai/mcp"
const MAX_RESPONSE_BYTES = 256 * 1024

function envProvider() {
  const value = (
    process.env.CODEX_WEB_SEARCH_PROVIDER ||
    process.env.SWITCHGATE_WEB_SEARCH_PROVIDER ||
    process.env.OPENCODE_WEBSEARCH_PROVIDER ||
    ""
  )
    .trim()
    .toLowerCase()
  return value === "exa" || value === "parallel" ? value : undefined
}

function selectedProvider(override) {
  const normalized = cleanString(override).toLowerCase()
  if (normalized === "exa" || normalized === "parallel") return normalized
  const configured = envProvider()
  if (configured) return configured
  if (process.env.PARALLEL_API_KEY?.trim()) return "parallel"
  return "exa"
}

function exaUrl() {
  const apiKey = process.env.EXA_API_KEY?.trim()
  if (!apiKey) return EXA_WEB_SEARCH_URL
  const url = new URL(EXA_WEB_SEARCH_URL)
  url.searchParams.set("exaApiKey", apiKey)
  return url.toString()
}

function requestHeaders(provider) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  }
  if (provider === "parallel") {
    headers["user-agent"] = "codex-switchgate/0.2"
    const apiKey = process.env.PARALLEL_API_KEY?.trim()
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

function mcpRequestBody(provider, input) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params:
      provider === "parallel"
        ? {
            name: "web_search",
            arguments: {
              objective: input.query,
              search_queries: [input.query],
              ...(input.sessionId ? { session_id: input.sessionId } : {}),
              ...(input.modelName ? { model_name: input.modelName.slice(0, 100) } : {}),
            },
          }
        : {
            name: "web_search_exa",
            arguments: {
              query: input.query,
              type: input.type,
              numResults: input.numResults,
              livecrawl: input.livecrawl,
              ...(input.contextMaxCharacters
                ? { contextMaxCharacters: input.contextMaxCharacters }
                : {}),
            },
          },
  }
}

function parsePayload(payload) {
  const trimmed = payload.trim()
  if (!trimmed || !trimmed.startsWith("{")) return undefined
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isObject(parsed)) return undefined
  const content = parsed.result?.content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter((entry) => isObject(entry) && typeof entry.text === "string")
    .map((entry) => entry.text.trim())
    .filter(Boolean)
  return texts.length ? texts.join("\n") : undefined
}

function parseWebSearchMcpResponse(body) {
  const trimmed = body.trim()
  if (trimmed) {
    const direct = parsePayload(trimmed)
    if (direct) return direct
  }
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice("data: ".length)
    if (data.trim() === "[DONE]") continue
    const parsed = parsePayload(data)
    if (parsed) return parsed
  }
  return ""
}

function cleanSummary(value, title) {
  const titleText = compactWhitespace(title)
  const lines = cleanString(value)
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(
      (line) =>
        line &&
        line !== "..." &&
        !line.startsWith("![") &&
        !/^#{1,6}\s/.test(line) &&
        line !== titleText,
    )
  return compactWhitespace(lines.join(" ")).slice(0, 1500)
}

function normalizeResult(value) {
  if (!isObject(value)) return null
  const url = cleanString(
    value.url || value.link || value.href || value.source_url || value.sourceUrl,
  )
  if (!/^https?:\/\//i.test(url)) return null
  const title = compactWhitespace(
    value.title || value.name || value.headline || value.source_title || domainFromUrl(url),
  )
  const summary = cleanSummary(
    value.summary ||
      value.snippet ||
      value.description ||
      value.text ||
      value.content ||
      value.highlights,
    title,
  )
  return {
    title,
    url,
    domain: domainFromUrl(url),
    publishedAt: normalizePublishedAt(
      value.publishedAt ||
        value.published_at ||
        value.published ||
        value.datePublished ||
        value.date,
    ),
    summary,
  }
}

function findResultArrays(value, depth = 0) {
  if (depth > 5) return []
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeResult).filter(Boolean)
    if (normalized.length) return normalized
    return value.flatMap((entry) => findResultArrays(entry, depth + 1))
  }
  if (!isObject(value)) return []
  for (const key of ["results", "items", "sources", "documents", "data"]) {
    const found = findResultArrays(value[key], depth + 1)
    if (found.length) return found
  }
  return Object.values(value).flatMap((entry) => findResultArrays(entry, depth + 1))
}

function parseJsonResults(text) {
  const trimmed = cleanString(text)
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return []
  try {
    return findResultArrays(JSON.parse(trimmed))
  } catch {
    return []
  }
}

function parseLabeledResults(text) {
  const blocks = cleanString(text).split(/\r?\n---\r?\n/)
  const results = []
  for (const block of blocks) {
    const titleMatch = block.match(/(?:^|\n)Title:\s*(.+)/i)
    const urlMatch = block.match(/(?:^|\n)URL:\s*(https?:\/\/\S+)/i)
    if (!urlMatch) continue
    const publishedMatch = block.match(/(?:^|\n)Published:\s*(.+)/i)
    const highlightsMatch = block.match(/(?:^|\n)Highlights:\s*([\s\S]*)$/i)
    const normalized = normalizeResult({
      title: titleMatch?.[1],
      url: urlMatch[1],
      published: publishedMatch?.[1],
      highlights: highlightsMatch?.[1] || "",
    })
    if (normalized) results.push(normalized)
  }
  return results
}

function parseMarkdownResults(text) {
  const results = []
  const pattern = /\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]+)\)/g
  for (const match of text.matchAll(pattern)) {
    const normalized = normalizeResult({
      title: match[1],
      url: match[2],
      summary: "",
    })
    if (normalized) results.push(normalized)
  }
  return results
}

function deduplicateResults(results, limit) {
  const seen = new Set()
  const output = []
  for (const result of results) {
    const key = result.url.replace(/#.*$/, "")
    if (seen.has(key)) continue
    seen.add(key)
    output.push(result)
    if (output.length >= limit) break
  }
  return output
}

function normalizeSearchResults(text, limit = 20) {
  const results = [
    ...parseJsonResults(text),
    ...parseLabeledResults(text),
    ...parseMarkdownResults(text),
  ]
  return deduplicateResults(results, limit)
}

function normalizeWebSearchInput(argumentsValue) {
  if (!isObject(argumentsValue)) throw new Error("web_search arguments must be an object")
  const query = cleanString(argumentsValue.query)
  if (!query) throw new Error("web_search requires a non-empty query")

  const provider = cleanString(argumentsValue.provider).toLowerCase()
  if (provider && !["auto", "exa", "parallel"].includes(provider)) {
    throw new Error("web_search provider must be auto, exa, or parallel")
  }
  const type = cleanString(argumentsValue.type).toLowerCase()
  if (type && !["auto", "fast", "deep"].includes(type)) {
    throw new Error("web_search type must be auto, fast, or deep")
  }
  const livecrawl = cleanString(argumentsValue.livecrawl).toLowerCase()
  if (livecrawl && !["fallback", "preferred"].includes(livecrawl)) {
    throw new Error("web_search livecrawl must be fallback or preferred")
  }

  return {
    query,
    provider: provider || "auto",
    numResults: cleanPositiveInteger(argumentsValue.numResults, 8, 1, 20),
    type: type || "auto",
    livecrawl: livecrawl || "fallback",
    contextMaxCharacters: cleanPositiveInteger(
      argumentsValue.contextMaxCharacters,
      undefined,
      1,
      200_000,
    ),
    sessionId: cleanString(argumentsValue.sessionId),
    modelName: cleanString(argumentsValue.modelName),
  }
}

async function executeWebSearch(input, signal) {
  if (typeof fetch !== "function") {
    throw new Error("web_search requires Node.js 18+ with global fetch support")
  }
  const provider = selectedProvider(input.provider)
  const timeout = withTimeout(
    signal,
    timeoutMs("SWITCHGATE_WEB_SEARCH_TIMEOUT_MS", 25_000),
  )
  try {
    const response = await fetch(provider === "parallel" ? PARALLEL_WEB_SEARCH_URL : exaUrl(), {
      method: "POST",
      headers: requestHeaders(provider),
      body: JSON.stringify(mcpRequestBody(provider, input)),
      signal: timeout.signal,
    })
    const body = await readFetchResponseText(response, MAX_RESPONSE_BYTES, "web_search")
    if (!response.ok) {
      throw new Error(`web_search ${provider} returned HTTP ${response.status}: ${body.slice(0, 500)}`)
    }
    const rawText = parseWebSearchMcpResponse(body)
    const results = normalizeSearchResults(rawText, input.numResults)
    return {
      query: input.query,
      provider,
      resultCount: results.length,
      results,
      ...(results.length || !rawText
        ? {}
        : { unparsedSummary: compactWhitespace(rawText).slice(0, 4000) }),
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`web_search ${provider} timed out`)
    }
    throw error
  } finally {
    timeout.done()
  }
}

module.exports = {
  executeWebSearch,
  normalizeSearchResults,
  normalizeWebSearchInput,
  parseWebSearchMcpResponse,
}
