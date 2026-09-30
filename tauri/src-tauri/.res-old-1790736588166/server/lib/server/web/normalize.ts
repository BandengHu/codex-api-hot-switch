import type { WebSearchResult } from "./types"

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "utm_campaign",
  "utm_content",
  "utm_medium",
  "utm_source",
  "utm_term",
])

export function compactWhitespace(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : ""
}

export function domainFromUrl(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./iu, "").toLowerCase()
  } catch {
    return null
  }
}

export function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || !/^https?:\/\//iu.test(value.trim())) return ""
  try {
    const url = new URL(value.trim())
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key)
    }
    url.hash = ""
    return url.toString()
  } catch {
    return ""
  }
}

export function normalizePublishedAt(value: unknown): string | null {
  const text = compactWhitespace(value)
  if (!text) return null
  const timestamp = Date.parse(text)
  if (!Number.isFinite(timestamp)) return null
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text
  return new Date(timestamp).toISOString()
}

function queryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .replace(/site:\S+/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/u)
      .filter((term) => term.length >= 2),
  )]
}

export function queryCoverage(query: string, text: string): number {
  const terms = queryTerms(query)
  if (terms.length === 0) return 0
  const normalized = text.toLowerCase()
  return terms.filter((term) => normalized.includes(term)).length / terms.length
}

function looksSyntheticTerm(term: string): boolean {
  if (!/^[a-z0-9]+$/iu.test(term) || term.length < 8) return false
  if (/\d/iu.test(term)) return true
  const letters = term.replace(/[^a-z]/giu, "")
  if (letters.length < 8) return false
  const vowels = letters.match(/[aeiou]/giu)?.length ?? 0
  return vowels / letters.length < 0.25
}

function syntheticTerms(query: string): string[] {
  return queryTerms(query).filter(looksSyntheticTerm)
}

export function filterLowConfidenceResults(
  results: WebSearchResult[],
  query: string,
): WebSearchResult[] {
  const terms = queryTerms(query)
  const suspicious = syntheticTerms(query)
  if (terms.length === 0 || suspicious.length === 0) return results

  return results.filter((result) => {
    const title = result.title.toLowerCase()
    const summary = result.summary.toLowerCase()
    const searchable = `${title} ${summary}`
    const coverage = queryCoverage(query, searchable)
    const suspiciousCoverage = suspicious.filter((term) => searchable.includes(term)).length
    return suspiciousCoverage === suspicious.length && coverage >= 0.5
  })
}

export function relevantSummary(value: unknown, query: string, maxChars = 280): string {
  const text = compactWhitespace(value).replace(/\.\.\./gu, "")
  if (!text) return ""
  const terms = queryTerms(query)
  const sentences = text.split(/(?<=[.!?。！？])\s+/u).filter(Boolean)
  const ranked = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: terms.reduce(
        (sum, term) => sum + (sentence.toLowerCase().includes(term) ? 1 : 0),
        0,
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
  const selected = (ranked.some((item) => item.score > 0)
    ? ranked.filter((item) => item.score > 0)
    : ranked
  ).map((item) => item.sentence)
  let output = ""
  for (const sentence of selected) {
    const next = output ? `${output} ${sentence}` : sentence
    if (next.length > maxChars) break
    output = next
  }
  if (!output) output = text.slice(0, maxChars)
  return output.slice(0, maxChars).trim()
}

function titleFromUrl(url: string, summary: string): string {
  const domain = domainFromUrl(url) || url
  try {
    const path = decodeURIComponent(new URL(url).pathname)
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/\.(html?|md|pdf)$/iu, "")
      .replace(/[-_]+/gu, " ")
      .trim()
    if (path && path.length > 2) return path
  } catch {
    // Fall through to the domain.
  }
  const firstSentence = compactWhitespace(summary).split(/(?<=[.!?。！？])\s+/u)[0]
  return firstSentence?.slice(0, 120) || domain
}

export function normalizeTitle(value: unknown, url: string, summary: string): string {
  const title = compactWhitespace(value)
  if (title && !/^(readme|home|untitled|source \d+)$/iu.test(title)) return title
  return titleFromUrl(url, summary)
}

export function isBlockedPage(title: string, summary: string, url: string): boolean {
  const text = `${title} ${summary} ${url}`.toLowerCase()
  return /captcha|verify you are human|access denied|cloudflare|waf|login required|sign in to continue|机器人验证/.test(text)
}

export function normalizeScore(value: unknown, rank: number, total: number, query: string, text: string): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : null
  const rankScore = total > 1 ? 1 - rank / (total - 1) : 1
  const matchScore = queryCoverage(query, text)
  const rawScore = raw === null ? rankScore : raw > 1 ? 1 / (1 + raw) : Math.max(0, Math.min(1, raw))
  const score = raw === null
    ? rankScore * 0.25 + matchScore * 0.75
    : rawScore * 0.7 + rankScore * 0.1 + matchScore * 0.2
  return Number(Math.max(0, Math.min(1, score)).toFixed(4))
}

export function dedupeResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>()
  return results.filter((result) => {
    const key = normalizeUrl(result.url) || result.url
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
