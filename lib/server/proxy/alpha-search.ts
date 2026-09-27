import type { ProxyTarget } from "./common"
import {
  isOpenAIResponsesProtocol,
  providerHeaders,
  responseId,
} from "./common"
import { browseWebPages, searchWeb } from "../web"
import type { BrowsePage, WebSearchResponse } from "../web"
import type { AlphaSearchMode } from "@/lib/types"

type AnyRecord = Record<string, any>

const ALPHA_COMMANDS = new Set([
  "search_query",
  "image_query",
  "open",
  "click",
  "find",
  "screenshot",
  "finance",
  "weather",
  "sports",
  "time",
  "response_length",
])

type AlphaSession = {
  refs: Map<string, BrowsePage>
  links: Map<string, string>
  touchedAt: number
}

const alphaSessions = new Map<string, AlphaSession>()
const MAX_ALPHA_SESSIONS = 64
const MAX_ALPHA_REFS = 128
const MAX_ALPHA_RESPONSE_BYTES = 2 * 1024 * 1024

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function isAlphaSearchPath(path: string) {
  const normalized = path.replace(/^\/+/, "").split("?")[0]
  return /(^|\/)alpha\/search$/.test(normalized)
}

export function shouldUseLocalAlphaSearch(
  target: ProxyTarget,
  mode: AlphaSearchMode,
) {
  if (mode === "local") return true
  if (mode === "upstream") return false
  return !(
    isOpenAIResponsesProtocol(target.provider.protocol) &&
    target.provider.rawResponsesPassthrough === true
  )
}

function splitQuery(value: string) {
  const index = value.indexOf("?")
  return index < 0
    ? { path: value, query: "" }
    : { path: value.slice(0, index), query: value.slice(index + 1) }
}

function alphaSearchUrl(baseUrl: string, path: string) {
  const skipVersionPrefix = baseUrl.trim().endsWith("#")
  const normalizedBase = baseUrl
    .trim()
    .replace(/#+$/, "")
    .split("#", 1)[0]
  const baseParts = splitQuery(normalizedBase)
  const basePath = baseParts.path.replace(/\/+$/, "")
  const requestParts = splitQuery(path.replace(/^\/+/, ""))

  try {
    new URL(basePath)
  } catch {
    throw new Error("Alpha Search 需要合法的上游 URL")
  }

  let url: string
  if (/\/responses\/compact$/i.test(basePath)) {
    url = basePath.replace(/\/responses\/compact$/i, "/alpha/search")
  } else if (/\/responses$/i.test(basePath)) {
    url = basePath.replace(/\/responses$/i, "/alpha/search")
  } else {
    const upstreamPath =
      !skipVersionPrefix &&
      /(?:^|\/)(?:v\d+(?:beta)?|api\/v\d+)$/i.test(basePath) &&
      requestParts.path.startsWith("v1/")
        ? requestParts.path.slice(3)
        : requestParts.path
    url = `${basePath}/${upstreamPath}`
  }

  const query = [baseParts.query, requestParts.query].filter(Boolean).join("&")
  return query ? `${url}?${query}` : url
}

export function buildAlphaSearchRequest(
  target: ProxyTarget,
  path: string,
  body: unknown,
) {
  if (target.provider.protocol !== "openai-responses") {
    throw new Error("Alpha Search 只能转发到 OpenAI Responses 供应商")
  }
  if (!isObject(body)) {
    throw new Error("Alpha Search 请求体必须是 JSON 对象")
  }

  const rewrittenBody = structuredClone(body)
  if (Object.hasOwn(rewrittenBody, "model")) {
    rewrittenBody.model = target.modelId
  }

  return {
    url: alphaSearchUrl(target.provider.baseUrl, path),
    rewrittenBody,
    init: {
      method: "POST",
      headers: providerHeaders(target.provider, {
        accept: "application/json",
        "content-type": "application/json",
      }),
      body: JSON.stringify(rewrittenBody),
    },
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function numberValue(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.trunc(number)))
    : fallback
}

function responseLength(value: unknown) {
  const normalized = stringValue(value).toLowerCase()
  if (normalized === "short" || normalized === "low") return { name: "short", limit: 4, chars: 4000 }
  if (normalized === "long" || normalized === "high") return { name: "long", limit: 20, chars: 20_000 }
  return { name: "medium", limit: 8, chars: 10_000 }
}

function sessionFor(body: AnyRecord) {
  const sessionId = stringValue(
    body.id ||
      body.session_id ||
      (isObject(body.metadata) && (body.metadata.session_id || body.metadata.sessionId)) ||
      "default",
  )
  let session = alphaSessions.get(sessionId)
  if (!session) {
    session = { refs: new Map(), links: new Map(), touchedAt: Date.now() }
    alphaSessions.set(sessionId, session)
  }
  session.touchedAt = Date.now()
  while (alphaSessions.size > MAX_ALPHA_SESSIONS) {
    const oldest = [...alphaSessions.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]
    if (!oldest) break
    alphaSessions.delete(oldest[0])
  }
  return session
}

function commandArguments(body: AnyRecord, command: string): AnyRecord {
  const direct = body[command]
  if (isObject(direct)) return { ...body, ...direct }
  if (typeof direct === "string") return { ...body, query: direct }
  if (isObject(body.arguments)) return { ...body, ...body.arguments }
  return body
}

function commandFromBody(body: AnyRecord): string {
  const explicit = stringValue(body.command || body.operation || body.action || body.type).toLowerCase()
  if (ALPHA_COMMANDS.has(explicit)) return explicit
  for (const command of ALPHA_COMMANDS) {
    if (Object.prototype.hasOwnProperty.call(body, command)) return command
  }
  return "search_query"
}

function queryFromArgs(args: AnyRecord) {
  return stringValue(args.query || args.q || args.search_query || args.input || args.objective)
}

function linksFromPage(page: BrowsePage) {
  const links: Array<{ id: string; url: string; title: string }> = []
  for (const match of String(page.content || "").matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/gu)) {
    links.push({
      id: String(links.length + 1),
      title: match[1].trim(),
      url: match[2],
    })
    if (links.length >= 100) break
  }
  return links
}

function rememberPage(session: AlphaSession, page: BrowsePage, links: Array<{ id: string; url: string; title: string }>) {
  const refId = `alpha_${crypto.randomUUID().replaceAll("-", "")}`
  session.refs.set(refId, page)
  for (const link of links) session.links.set(`${refId}:${link.id}`, link.url)
  while (session.refs.size > MAX_ALPHA_REFS) {
    const oldest = session.refs.keys().next().value as string | undefined
    if (!oldest) break
    session.refs.delete(oldest)
    for (const key of session.links.keys()) if (key.startsWith(`${oldest}:`)) session.links.delete(key)
  }
  return refId
}

function resolvePageUrl(session: AlphaSession, args: AnyRecord) {
  const refId = stringValue(args.ref_id || args.refId || args.reference_id)
  const linkId = stringValue(args.id || args.link_id || args.linkId)
  if (refId && linkId) return session.links.get(`${refId}:${linkId}`) || ""
  if (refId && /^https?:\/\//iu.test(refId)) return refId
  return stringValue(args.url)
}

async function readJson(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "user-agent": "SwitchGate Alpha Search",
      ...(init.headers || {}),
    },
    signal,
  })
  const text = await response.text()
  if (text.length > MAX_ALPHA_RESPONSE_BYTES) {
    throw new Error("Alpha Search 上游响应超过大小限制")
  }
  let payload: unknown
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`Alpha Search 上游返回无效 JSON（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const message = isObject(payload) && isObject(payload.error)
      ? stringValue(payload.error.message)
      : ""
    throw new Error(message || `Alpha Search 上游返回 HTTP ${response.status}`)
  }
  return payload
}

async function executeImageQuery(args: AnyRecord, signal?: AbortSignal) {
  const query = queryFromArgs(args)
  if (!query) throw new Error("image_query 缺少 query")
  const page = await readJson(
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
    { headers: { accept: "text/html" } },
    signal,
  )
  const source = JSON.stringify(page)
  const vqd = source.match(/vqd["']?\s*[:=]\s*["']([^"']+)/iu)?.[1]
  if (!vqd) return { query, results: [] }
  const payload = await readJson(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,`,
    { headers: { referer: "https://duckduckgo.com/", accept: "application/json" } },
    signal,
  )
  const results = Array.isArray(payload?.results)
    ? payload.results.slice(0, 20).map((item: AnyRecord) => ({
        title: stringValue(item.title),
        imageUrl: stringValue(item.image),
        thumbnailUrl: stringValue(item.thumbnail),
        sourceUrl: stringValue(item.url),
        source: stringValue(item.source),
      })).filter((item: AnyRecord) => item.imageUrl)
    : []
  return { query, results }
}

async function executeFinance(args: AnyRecord, signal?: AbortSignal) {
  const symbol = stringValue(args.ticker || args.symbol || args.query).toUpperCase()
  if (!symbol) throw new Error("finance 缺少 ticker 或 symbol")
  const payload = await readJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=5m`,
    {},
    signal,
  )
  const result = payload?.chart?.result?.[0]
  return {
    symbol,
    currency: result?.meta?.currency || null,
    exchange: result?.meta?.exchangeName || null,
    price: result?.meta?.regularMarketPrice ?? null,
    previousClose: result?.meta?.previousClose ?? null,
    timestamps: result?.timestamp || [],
    indicators: result?.indicators?.quote?.[0] || {},
  }
}

async function executeWeather(args: AnyRecord, signal?: AbortSignal) {
  const location = stringValue(args.location || args.city || args.query)
  if (!location) throw new Error("weather 缺少 location")
  const geo = await readJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`,
    {},
    signal,
  )
  const place = geo?.results?.[0]
  if (!place) throw new Error(`找不到天气地点：${location}`)
  const forecast = await readJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`,
    {},
    signal,
  )
  return { location: place, current: forecast.current || null, timezone: forecast.timezone || null }
}

async function executeSports(args: AnyRecord, signal?: AbortSignal) {
  const league = stringValue(args.league || args.sport || args.query).toLowerCase()
  const map: Record<string, string> = {
    nfl: "football/nfl",
    nba: "basketball/nba",
    mlb: "baseball/mlb",
    nhl: "hockey/nhl",
    epl: "soccer/eng.1",
    ncaamb: "basketball/mens-college-basketball",
    ncaawb: "basketball/womens-college-basketball",
  }
  const path = map[league] || map.nba
  const date = stringValue(args.date)
  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard${date ? `?dates=${encodeURIComponent(date.replaceAll("-", ""))}` : ""}`
  return readJson(url, {}, signal)
}

function executeTime(args: AnyRecord) {
  const offset = stringValue(args.utc_offset || args.utcOffset || args.offset || "+00:00")
  if (!/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/u.test(offset)) {
    throw new Error("time 的 utc_offset 必须是 ±HH:MM")
  }
  const sign = offset.startsWith("-") ? -1 : 1
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4)))
  const now = new Date(Date.now() + minutes * 60_000)
  return { utc_offset: offset, iso: now.toISOString(), unix: now.getTime() }
}

async function executeAlphaCommand(command: string, args: AnyRecord, session: AlphaSession, signal?: AbortSignal) {
  const length = responseLength(args.response_length || args.responseLength)
  switch (command) {
    case "search_query": {
      const query = queryFromArgs(args)
      if (!query) throw new Error("search_query 缺少 query")
      const search = await searchWeb({
        queries: [{ query, recencyDays: numberValue(args.recencyDays, 0, 0, 3650) || undefined, domains: Array.isArray(args.domains) ? args.domains : undefined, language: stringValue(args.language) || undefined }],
        limit: numberValue(args.limit || args.num_results || args.numResults, length.limit, 1, 20),
      }, signal)
      return search
    }
    case "image_query":
      return executeImageQuery(args, signal)
    case "open": {
      const url = resolvePageUrl(session, args)
      if (!url) throw new Error("open 缺少 url 或 ref_id")
      const response = await browseWebPages({ url, format: "markdown", maxCharacters: length.chars }, signal)
      const page = response.pages[0]
      if (!page || page.error) return response
      const links = linksFromPage(page)
      const refId = rememberPage(session, page, links)
      return { ...page, ref_id: refId, links }
    }
    case "click": {
      const url = resolvePageUrl(session, args)
      if (!url) throw new Error("click 缺少 ref_id 和 link id")
      const response = await browseWebPages({ url, format: "markdown", maxCharacters: length.chars }, signal)
      const page = response.pages[0]
      if (!page || page.error) return response
      const links = linksFromPage(page)
      const refId = rememberPage(session, page, links)
      return { ...page, ref_id: refId, links }
    }
    case "find": {
      const refId = stringValue(args.ref_id || args.refId)
      const page = session.refs.get(refId)
      const pattern = stringValue(args.pattern || args.query)
      if (!page || !pattern) throw new Error("find 需要有效 ref_id 和 pattern")
      const lines = String(page.content || "").split(/\r?\n/)
      return { ref_id: refId, pattern, matches: lines.map((line, index) => ({ line: index + 1, text: line })).filter((item) => item.text.toLowerCase().includes(pattern.toLowerCase())).slice(0, 100) }
    }
    case "screenshot":
      throw new Error("unsupported_command: 当前运行时未安装 PDF.js Canvas，暂不能渲染 PDF 页面")
    case "finance":
      return executeFinance(args, signal)
    case "weather":
      return executeWeather(args, signal)
    case "sports":
      return executeSports(args, signal)
    case "time":
      return executeTime(args)
    case "response_length":
      return length
    default:
      throw new Error(`unsupported_command: ${command}`)
  }
}

export async function executeLocalAlphaSearch(body: unknown, signal?: AbortSignal) {
  if (!isObject(body)) throw new Error("Alpha Search 请求体必须是 JSON 对象")
  const session = sessionFor(body)
  const commands = Array.isArray(body.commands)
    ? body.commands.map((item) => isObject(item) ? item : { query: item })
    : [body]
  const results = []
  for (const item of commands) {
    const command = commandFromBody(item)
    if (!ALPHA_COMMANDS.has(command)) {
      results.push({ command, error: { code: "unsupported_command", message: `不支持的 Alpha Search 命令：${command}`, retryable: false, provider: "switchgate" } })
      continue
    }
    try {
      results.push({ command, result: await executeAlphaCommand(command, commandArguments(item, command), session, signal) })
    } catch (error) {
      results.push({ command, error: { code: error instanceof Error && error.message.startsWith("unsupported_command") ? "unsupported_command" : "alpha_search_error", message: error instanceof Error ? error.message : String(error), retryable: false, provider: "switchgate" } })
    }
  }
  return {
    id: stringValue(body.id) || responseId("alpha"),
    object: "alpha_search.result",
    status: "completed",
    results,
  }
}
