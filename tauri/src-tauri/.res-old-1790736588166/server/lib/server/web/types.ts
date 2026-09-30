export type SearchCapabilitySupport = "native" | "query" | "none"

export interface SearchCapabilities {
  site: SearchCapabilitySupport
  exactPhrase: SearchCapabilitySupport
  timeRange: SearchCapabilitySupport
  language: SearchCapabilitySupport
}

export interface WebToolError {
  code: string
  message: string
  retryable: boolean
  provider: string
  status?: number
  query?: string
}

export interface WebSearchQuery {
  query: string
  recencyDays?: number
  domains?: string[]
  language?: string
}

export interface WebSearchRequest {
  queries: WebSearchQuery[]
  limit: number
  answer?: boolean
  includeContent?: boolean
}

export interface WebSearchResult {
  query: string
  title: string
  url: string
  domain: string | null
  summary: string
  score: number
  publishedAt: string | null
  provider: string
  content?: string
  contentType?: string
  finalUrl?: string
  contentTruncated?: boolean
}

export interface WebSearchGroup {
  query: string
  total: number
  limit: number
  hasMore: boolean
  provider: string
  capabilities: SearchCapabilities
  results: WebSearchResult[]
  scoreBasis: "relative"
  answer?: string
  error?: WebToolError
}

export interface WebSearchResponse {
  groups: WebSearchGroup[]
  errors: WebToolError[]
}

export interface BrowsePage {
  url: string
  finalUrl?: string
  domain?: string | null
  title?: string
  publishedAt?: string | null
  contentType?: string
  content?: string
  truncated?: boolean
  error?: string
}

export interface BrowsePageResponse {
  pageCount: number
  pages: BrowsePage[]
}

export const DEFAULT_SEARCH_CAPABILITIES: SearchCapabilities = {
  site: "query",
  exactPhrase: "query",
  timeRange: "query",
  language: "query",
}
