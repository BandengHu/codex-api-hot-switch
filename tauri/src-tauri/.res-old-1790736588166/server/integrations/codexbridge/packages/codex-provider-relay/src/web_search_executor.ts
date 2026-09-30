import type {
  CodexProviderRelayHostedToolExecutionRequest,
  CodexProviderRelayHostedToolExecutionResult,
  CodexProviderRelayHostedToolExecutor,
  JsonRecord,
} from './hosted_tool_executors.js';

export type CodexProviderRelayWebSearchProvider =
  | 'tavily'
  | 'brave'
  | 'serper';

export type CodexProviderRelayWebSearchContextSize = 'low' | 'medium' | 'high';

export interface CodexProviderRelayWebSearchExecutorOptions {
  provider?: CodexProviderRelayWebSearchProvider | null;
  apiKey?: string | null;
  endpoint?: string | null;
  fetchImpl?: typeof fetch;
  maxResults?: number | null;
  country?: string | null;
  language?: string | null;
  sources?: CodexProviderRelayWebSearchSourceInput[] | null;
}

export type CodexProviderRelayWebSearchSourceInput =
  | CodexProviderRelayWebSearchSource
  | CodexProviderRelayProviderWebSearchSourceOptions;

export interface CodexProviderRelayProviderWebSearchSourceOptions {
  type?: 'provider' | null;
  provider: CodexProviderRelayWebSearchProvider;
  apiKey: string;
  endpoint?: string | null;
  fetchImpl?: typeof fetch;
  maxResults?: number | null;
  country?: string | null;
  language?: string | null;
}

export interface CodexProviderRelayWebSearchSource {
  name: string;
  type?: string | null;
  live?: boolean | null;
  search(
    request: CodexProviderRelayWebSearchSourceRequest,
  ): Promise<CodexProviderRelayWebSearchSourceResult> | CodexProviderRelayWebSearchSourceResult;
}

export interface CodexProviderRelayWebSearchSourceRequest {
  query: string;
  maxResults: number;
  searchContextSize: CodexProviderRelayWebSearchContextSize;
  userLocation: JsonRecord | null;
  filters: CodexProviderRelayWebSearchFilters | null;
  externalWebAccess: boolean;
  returnTokenBudget: number | null;
  toolRequest: CodexProviderRelayHostedToolExecutionRequest;
}

export interface CodexProviderRelayWebSearchFilters {
  allowedDomains: string[];
  blockedDomains: string[];
  raw: JsonRecord | null;
}

export interface CodexProviderRelayWebSearchSourceResult {
  answer?: string | null;
  results: CodexProviderRelayWebSearchResult[];
  sources?: CodexProviderRelayWebSearchSourceReference[] | null;
  citations?: CodexProviderRelayWebSearchCitation[] | null;
  metadata?: JsonRecord | null;
}

export interface CodexProviderRelayWebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string | null;
  publishedAt?: string | null;
  score?: number | null;
}

export interface CodexProviderRelayWebSearchSourceReference {
  title?: string | null;
  url: string;
  source?: string | null;
  snippet?: string | null;
}

export interface CodexProviderRelayWebSearchCitation {
  type?: string | null;
  title?: string | null;
  url: string;
  start_index?: number | null;
  end_index?: number | null;
}

export interface CodexProviderRelayWebSearchExecutorContent {
  query: string;
  provider: string;
  answer?: string | null;
  results: CodexProviderRelayWebSearchResult[];
  sources?: CodexProviderRelayWebSearchSourceReference[];
  citations?: CodexProviderRelayWebSearchCitation[];
  retrieved_at: string;
  external_web_access: boolean;
  search_context_size: CodexProviderRelayWebSearchContextSize;
  return_token_budget?: number | null;
}

const DEFAULT_TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_SERPER_ENDPOINT = 'https://google.serper.dev/search';

export function createCodexProviderRelayWebSearchExecutor(
  options: CodexProviderRelayWebSearchExecutorOptions,
): CodexProviderRelayHostedToolExecutor {
  const sources = normalizeWebSearchSources(options);
  if (sources.length === 0) {
    throw new Error('web_search executor requires at least one source or provider API key.');
  }
  return async (request: CodexProviderRelayHostedToolExecutionRequest): Promise<CodexProviderRelayHostedToolExecutionResult> => {
    const normalizedRequest = normalizeWebSearchRequest(request, options.maxResults);
    if (!normalizedRequest.query) {
      throw new Error('web_search executor requires a non-empty query argument.');
    }
    const liveSources = sources.filter((source) => source.live !== false);
    const cacheSources = sources.filter((source) => source.live === false);
    const searchableSources = normalizedRequest.externalWebAccess ? sources : cacheSources;
    if (!normalizedRequest.externalWebAccess && liveSources.length > 0 && searchableSources.length === 0) {
      throw new Error('web_search external_web_access=false requires a cache/offline source; live providers were not called.');
    }

    const aggregatedResults: CodexProviderRelayWebSearchResult[] = [];
    const aggregatedSources: CodexProviderRelayWebSearchSourceReference[] = [];
    const aggregatedCitations: CodexProviderRelayWebSearchCitation[] = [];
    const answers: string[] = [];
    for (const source of searchableSources) {
      const result = await source.search({
        ...normalizedRequest,
        toolRequest: request,
      });
      if (normalizeString(result.answer)) {
        answers.push(normalizeString(result.answer));
      }
      for (const entry of result.results ?? []) {
        const normalized = normalizeWebSearchResult(entry, source.name);
        if (normalized && webSearchResultMatchesFilters(normalized, normalizedRequest.filters)) {
          aggregatedResults.push(normalized);
        }
      }
      for (const entry of result.sources ?? []) {
        const normalized = normalizeWebSearchSourceReference(entry, source.name);
        if (normalized && webSearchUrlMatchesFilters(normalized.url, normalizedRequest.filters)) {
          aggregatedSources.push(normalized);
        }
      }
      for (const entry of result.citations ?? []) {
        const normalized = normalizeWebSearchCitation(entry);
        if (normalized && webSearchUrlMatchesFilters(normalized.url, normalizedRequest.filters)) {
          aggregatedCitations.push(normalized);
        }
      }
    }

    const limitedResults = aggregatedResults.slice(0, normalizedRequest.maxResults);
    const sourcesFromResults = limitedResults.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
      source: result.source ?? null,
    }));
    return {
      content: {
        query: normalizedRequest.query,
        provider: searchableSources.length === 1 ? searchableSources[0].name : 'multi-source',
        answer: answers[0] ?? null,
        results: limitedResults,
        sources: dedupeWebSearchSources([...aggregatedSources, ...sourcesFromResults]),
        citations: dedupeWebSearchCitations(aggregatedCitations),
        retrieved_at: new Date().toISOString(),
        external_web_access: normalizedRequest.externalWebAccess,
        search_context_size: normalizedRequest.searchContextSize,
        return_token_budget: normalizedRequest.returnTokenBudget,
      } satisfies CodexProviderRelayWebSearchExecutorContent,
      metadata: {
        provider: searchableSources.length === 1 ? searchableSources[0].name : 'multi-source',
        sourceCount: searchableSources.length,
        resultCount: limitedResults.length,
        externalWebAccess: normalizedRequest.externalWebAccess,
        searchContextSize: normalizedRequest.searchContextSize,
        returnTokenBudget: normalizedRequest.returnTokenBudget,
      },
    };
  };
}

export function createCodexProviderRelayProviderWebSearchSource(
  options: CodexProviderRelayProviderWebSearchSourceOptions,
): CodexProviderRelayWebSearchSource {
  const provider = normalizeWebSearchProvider(options.provider);
  const apiKey = normalizeString(options.apiKey);
  if (!apiKey) {
    throw new Error(`${provider} web_search source requires an API key.`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxResults = clampInteger(options.maxResults, 1, 10, 5);
  const endpoint = normalizeString(options.endpoint) || defaultEndpointForWebSearchProvider(provider);
  const country = normalizeString(options.country);
  const language = normalizeString(options.language);
  return {
    name: provider,
    type: provider,
    live: true,
    search(request) {
      switch (provider) {
        case 'tavily':
          return executeTavilySearch({
            apiKey,
            endpoint,
            fetchImpl,
            maxResults: Math.min(maxResults, request.maxResults),
            request,
          });
        case 'brave':
          return executeBraveSearch({
            apiKey,
            endpoint,
            fetchImpl,
            maxResults: Math.min(maxResults, request.maxResults),
            request,
            country,
            language,
          });
        case 'serper':
          return executeSerperSearch({
            apiKey,
            endpoint,
            fetchImpl,
            maxResults: Math.min(maxResults, request.maxResults),
            request,
            country,
            language,
          });
        default:
          throw new Error(`Unsupported web_search source provider: ${provider}`);
      }
    },
  };
}

async function executeTavilySearch({
  apiKey,
  endpoint,
  fetchImpl,
  maxResults,
  request,
}: {
  apiKey: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  maxResults: number;
  request: CodexProviderRelayWebSearchSourceRequest;
}): Promise<CodexProviderRelayWebSearchSourceResult> {
  const response = await fetchJson(fetchImpl, endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: request.query,
      max_results: maxResults,
      search_depth: tavilySearchDepthFromContextSize(request.searchContextSize),
      include_answer: true,
      ...(request.filters?.allowedDomains.length ? { include_domains: request.filters.allowedDomains } : {}),
      ...(request.filters?.blockedDomains.length ? { exclude_domains: request.filters.blockedDomains } : {}),
    }),
  });
  const results = normalizeArray(response.results)
    .slice(0, maxResults)
    .map((result) => ({
      title: normalizeString(result?.title) || normalizeString(result?.url) || 'Untitled result',
      url: normalizeString(result?.url),
      snippet: normalizeString(result?.content) || normalizeString(result?.snippet),
      source: 'tavily',
      publishedAt: normalizeString(result?.published_date) || null,
      score: normalizeFiniteNumber(result?.score),
    }))
    .filter((result) => result.url);
  return {
    answer: normalizeString(response.answer) || null,
    results,
    sources: results.map(resultToSourceReference),
    citations: results.map(resultToCitation),
  };
}

async function executeBraveSearch({
  apiKey,
  endpoint,
  fetchImpl,
  maxResults,
  request,
  country,
  language,
}: {
  apiKey: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  maxResults: number;
  request: CodexProviderRelayWebSearchSourceRequest;
  country: string;
  language: string;
}): Promise<CodexProviderRelayWebSearchSourceResult> {
  const url = new URL(endpoint);
  url.searchParams.set('q', request.query);
  url.searchParams.set('count', String(maxResults));
  if (country) {
    url.searchParams.set('country', country.toUpperCase());
  }
  if (language) {
    url.searchParams.set('search_lang', language.toLowerCase());
  }
  const response = await fetchJson(fetchImpl, url.toString(), {
    method: 'GET',
    headers: {
      'X-Subscription-Token': apiKey,
      Accept: 'application/json',
    },
  });
  const results = normalizeArray(response.web?.results)
    .slice(0, maxResults)
    .map((result) => ({
      title: normalizeString(result?.title) || normalizeString(result?.url) || 'Untitled result',
      url: normalizeString(result?.url),
      snippet: normalizeString(result?.description) || normalizeString(result?.snippet),
      source: 'brave',
      publishedAt: normalizeString(result?.page_age) || normalizeString(result?.age) || null,
      score: normalizeFiniteNumber(result?.score),
    }))
    .filter((result) => result.url);
  return {
    results,
    sources: results.map(resultToSourceReference),
    citations: results.map(resultToCitation),
  };
}

async function executeSerperSearch({
  apiKey,
  endpoint,
  fetchImpl,
  maxResults,
  request,
  country,
  language,
}: {
  apiKey: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  maxResults: number;
  request: CodexProviderRelayWebSearchSourceRequest;
  country: string;
  language: string;
}): Promise<CodexProviderRelayWebSearchSourceResult> {
  const response = await fetchJson(fetchImpl, endpoint, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: request.query,
      num: maxResults,
      ...(country ? { gl: country.toLowerCase() } : {}),
      ...(language ? { hl: language.toLowerCase() } : {}),
    }),
  });
  const results = normalizeArray(response.organic)
    .slice(0, maxResults)
    .map((result) => ({
      title: normalizeString(result?.title) || normalizeString(result?.link) || 'Untitled result',
      url: normalizeString(result?.link),
      snippet: normalizeString(result?.snippet),
      source: 'serper',
      publishedAt: normalizeString(result?.date) || null,
      score: normalizeFiniteNumber(result?.position),
    }))
    .filter((result) => result.url);
  return {
    answer: normalizeString(response.answerBox?.answer)
      || normalizeString(response.knowledgeGraph?.description)
      || null,
    results,
    sources: results.map(resultToSourceReference),
    citations: results.map(resultToCitation),
  };
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<JsonRecord> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`web_search upstream returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    const json = JSON.parse(text) as JsonRecord;
    return json && typeof json === 'object' ? json : {};
  } catch (error) {
    throw new Error(`web_search upstream returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeWebSearchSources(
  options: CodexProviderRelayWebSearchExecutorOptions,
): CodexProviderRelayWebSearchSource[] {
  const sources: CodexProviderRelayWebSearchSource[] = [];
  if (Array.isArray(options.sources)) {
    for (const source of options.sources) {
      sources.push(normalizeWebSearchSource(source));
    }
  }
  if (normalizeString(options.provider) || normalizeString(options.apiKey)) {
    sources.push(createCodexProviderRelayProviderWebSearchSource({
      provider: options.provider ?? 'tavily',
      apiKey: options.apiKey ?? '',
      endpoint: options.endpoint,
      fetchImpl: options.fetchImpl,
      maxResults: options.maxResults,
      country: options.country,
      language: options.language,
    }));
  }
  return sources;
}

function normalizeWebSearchSource(source: CodexProviderRelayWebSearchSourceInput): CodexProviderRelayWebSearchSource {
  if (source && typeof (source as CodexProviderRelayWebSearchSource).search === 'function') {
    const adapter = source as CodexProviderRelayWebSearchSource;
    const name = normalizeString(adapter.name);
    if (!name) {
      throw new Error('web_search source adapters require a non-empty name.');
    }
    return {
      ...adapter,
      name,
      type: normalizeString(adapter.type) || 'custom',
      live: adapter.live !== false,
    };
  }
  return createCodexProviderRelayProviderWebSearchSource(source as CodexProviderRelayProviderWebSearchSourceOptions);
}

function normalizeWebSearchRequest(
  request: CodexProviderRelayHostedToolExecutionRequest,
  fallbackMaxResults: unknown,
): Omit<CodexProviderRelayWebSearchSourceRequest, 'toolRequest'> {
  return {
    query: webSearchQueryFromRequest(request),
    maxResults: clampInteger(
      request.arguments.max_results ?? request.arguments.max_num_results ?? request.arguments.num_results,
      1,
      20,
      clampInteger(fallbackMaxResults, 1, 20, 5),
    ),
    searchContextSize: normalizeSearchContextSize(request.arguments.search_context_size),
    userLocation: normalizeUserLocation(request.arguments.user_location),
    filters: normalizeWebSearchFilters(request.arguments.filters),
    externalWebAccess: request.arguments.external_web_access !== false,
    returnTokenBudget: normalizePositiveInteger(request.arguments.return_token_budget),
  };
}

function webSearchQueryFromRequest(request: CodexProviderRelayHostedToolExecutionRequest): string {
  return firstNonEmptyString([
    request.arguments.query,
    request.arguments.q,
    request.arguments.search_query,
    request.arguments.input,
    request.rawArguments,
  ]);
}

function normalizeSearchContextSize(value: unknown): CodexProviderRelayWebSearchContextSize {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return 'medium';
}

function tavilySearchDepthFromContextSize(
  contextSize: CodexProviderRelayWebSearchContextSize,
): 'basic' | 'advanced' | 'fast' {
  if (contextSize === 'high') {
    return 'advanced';
  }
  if (contextSize === 'low') {
    return 'fast';
  }
  return 'basic';
}

function normalizeUserLocation(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as JsonRecord;
  const approximate = record.approximate && typeof record.approximate === 'object'
    ? record.approximate as JsonRecord
    : record;
  const normalized = {
    type: normalizeString(record.type) || 'approximate',
    country: normalizeString(approximate.country),
    city: normalizeString(approximate.city),
    region: normalizeString(approximate.region),
    timezone: normalizeString(approximate.timezone),
  };
  return Object.fromEntries(Object.entries(normalized).filter(([, entry]) => Boolean(entry)));
}

function normalizeWebSearchFilters(value: unknown): CodexProviderRelayWebSearchFilters | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as JsonRecord;
  const allowedDomains = normalizeDomainList(
    record.allowed_domains ?? record.allowedDomains ?? record.include_domains ?? record.includeDomains,
  );
  const blockedDomains = normalizeDomainList(
    record.blocked_domains ?? record.blockedDomains ?? record.exclude_domains ?? record.excludeDomains,
  );
  return {
    allowedDomains,
    blockedDomains,
    raw: record,
  };
}

function normalizeDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .map((entry) => normalizeString(entry)
      .replace(/^https?:\/\//iu, '')
      .replace(/\/.*$/u, '')
      .toLowerCase())
    .filter(Boolean))];
}

function webSearchResultMatchesFilters(
  result: CodexProviderRelayWebSearchResult,
  filters: CodexProviderRelayWebSearchFilters | null,
): boolean {
  return webSearchUrlMatchesFilters(result.url, filters);
}

function webSearchUrlMatchesFilters(
  url: string,
  filters: CodexProviderRelayWebSearchFilters | null,
): boolean {
  if (!filters) {
    return true;
  }
  const hostname = hostnameFromUrl(url);
  if (!hostname) {
    return false;
  }
  if (filters.allowedDomains.length > 0 && !filters.allowedDomains.some((domain) => domainMatches(hostname, domain))) {
    return false;
  }
  if (filters.blockedDomains.some((domain) => domainMatches(hostname, domain))) {
    return false;
  }
  return true;
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function hostnameFromUrl(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeWebSearchResult(
  result: CodexProviderRelayWebSearchResult,
  fallbackSource: string,
): CodexProviderRelayWebSearchResult | null {
  const url = normalizeString(result.url);
  if (!url) {
    return null;
  }
  return {
    title: normalizeString(result.title) || url,
    url,
    snippet: normalizeString(result.snippet),
    source: normalizeString(result.source) || fallbackSource,
    publishedAt: normalizeString(result.publishedAt) || null,
    score: normalizeFiniteNumber(result.score),
  };
}

function normalizeWebSearchSourceReference(
  source: CodexProviderRelayWebSearchSourceReference,
  fallbackSource: string,
): CodexProviderRelayWebSearchSourceReference | null {
  const url = normalizeString(source.url);
  if (!url) {
    return null;
  }
  return {
    title: normalizeString(source.title) || url,
    url,
    source: normalizeString(source.source) || fallbackSource,
    snippet: normalizeString(source.snippet) || null,
  };
}

function normalizeWebSearchCitation(
  citation: CodexProviderRelayWebSearchCitation,
): CodexProviderRelayWebSearchCitation | null {
  const url = normalizeString(citation.url);
  if (!url) {
    return null;
  }
  return {
    type: normalizeString(citation.type) || 'url_citation',
    title: normalizeString(citation.title) || null,
    url,
    start_index: normalizeFiniteNumber(citation.start_index),
    end_index: normalizeFiniteNumber(citation.end_index),
  };
}

function resultToSourceReference(result: CodexProviderRelayWebSearchResult): CodexProviderRelayWebSearchSourceReference {
  return {
    title: result.title,
    url: result.url,
    source: result.source ?? null,
    snippet: result.snippet,
  };
}

function resultToCitation(result: CodexProviderRelayWebSearchResult): CodexProviderRelayWebSearchCitation {
  return {
    type: 'url_citation',
    title: result.title,
    url: result.url,
  };
}

function dedupeWebSearchSources(
  sources: CodexProviderRelayWebSearchSourceReference[],
): CodexProviderRelayWebSearchSourceReference[] {
  const seen = new Set<string>();
  const deduped: CodexProviderRelayWebSearchSourceReference[] = [];
  for (const source of sources) {
    const key = source.url;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(source);
  }
  return deduped;
}

function dedupeWebSearchCitations(
  citations: CodexProviderRelayWebSearchCitation[],
): CodexProviderRelayWebSearchCitation[] {
  const seen = new Set<string>();
  const deduped: CodexProviderRelayWebSearchCitation[] = [];
  for (const citation of citations) {
    const key = `${citation.url}:${citation.start_index ?? ''}:${citation.end_index ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(citation);
  }
  return deduped;
}

function defaultEndpointForWebSearchProvider(provider: CodexProviderRelayWebSearchProvider): string {
  switch (provider) {
    case 'tavily':
      return DEFAULT_TAVILY_ENDPOINT;
    case 'brave':
      return DEFAULT_BRAVE_ENDPOINT;
    case 'serper':
      return DEFAULT_SERPER_ENDPOINT;
    default:
      return '';
  }
}

function normalizeWebSearchProvider(value: unknown): CodexProviderRelayWebSearchProvider {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'tavily' || normalized === 'brave' || normalized === 'serper') {
    return normalized;
  }
  throw new Error(`Unsupported web_search executor provider: ${String(value)}`);
}

function firstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function normalizeFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
