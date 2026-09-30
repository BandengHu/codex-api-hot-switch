import path from 'node:path';
import type {
  CodexProviderRelayFileSearchChunk,
  CodexProviderRelayFileSearchExecutorContent,
  CodexProviderRelayFileSearchExecutorOptions,
  CodexProviderRelayFileSearchFilter,
  CodexProviderRelayFileSearchRankingOptions,
  CodexProviderRelayFileSearchResult,
  CodexProviderRelayFileSearchSource,
  CodexProviderRelayFileSearchSourceInput,
  CodexProviderRelayFileSearchSourceMatch,
  CodexProviderRelayHostedToolExecutionRequest,
  CodexProviderRelayHostedToolExecutionResult,
  CodexProviderRelayHostedToolExecutor,
  CodexProviderRelayInMemoryVectorFileSearchSourceOptions,
  CodexProviderRelayLocalFileSearchSourceOptions,
  CodexProviderRelayLocalVectorFileSearchSourceOptions,
  CodexProviderRelayMemoryFileSearchSourceOptions,
  CodexProviderRelayRemoteDocumentsFileSearchSourceOptions,
  CodexProviderRelaySqliteFtsFileSearchSourceOptions,
  CodexProviderRelayVectorStoreFileSearchSourceOptions,
  JsonRecord,
  NormalizedFileSearchOptions,
} from './types.js';
import {
  createCodexProviderRelayInMemoryVectorFileSearchSource,
  createCodexProviderRelayLocalFileSearchSource,
  createCodexProviderRelayLocalVectorFileSearchSource,
  createCodexProviderRelayMemoryFileSearchSource,
  createCodexProviderRelayRemoteDocumentsFileSearchSource,
  createCodexProviderRelaySqliteFtsFileSearchSource,
  createCodexProviderRelayVectorStoreFileSearchSource,
} from './sources.js';
import {
  clampInteger,
  clampNumber,
  firstNonEmptyString,
  normalizeFileSearchAttributes,
  normalizeNonNegativeInteger,
  normalizePathGlob,
  normalizeRelativePath,
  normalizeString,
  normalizeStringArray,
  stableFileSearchFileId,
  tokenizeQuery,
} from './shared.js';

export function createCodexProviderRelayFileSearchExecutor(
  options: CodexProviderRelayFileSearchExecutorOptions,
): CodexProviderRelayHostedToolExecutor {
  const normalizedOptions = normalizeFileSearchOptions(options);
  return async (
    request: CodexProviderRelayHostedToolExecutionRequest,
  ): Promise<CodexProviderRelayHostedToolExecutionResult> => {
    const query = fileSearchQueryFromRequest(request);
    if (!query) {
      throw new Error('file_search executor requires a non-empty query argument.');
    }
    const terms = tokenizeQuery(query);
    if (terms.length === 0) {
      throw new Error('file_search executor requires at least one searchable query term.');
    }
    const maxResults = fileSearchMaxResultsFromRequest(request, normalizedOptions.maxResults);
    const includeContent = typeof request.arguments.include_content === 'boolean'
      ? request.arguments.include_content
      : normalizedOptions.includeContent;
    const pathGlob = normalizePathGlob(request.arguments.path_glob);
    const vectorStoreIds = normalizeStringArray(request.arguments.vector_store_ids);
    const filters = normalizeFileSearchFilter(request.arguments.filters ?? request.arguments.attribute_filter);
    const rankingOptions = normalizeFileSearchRankingOptions(request.arguments.ranking_options);
    const searchSources = selectFileSearchSources(normalizedOptions.sources, vectorStoreIds);

    await request.emitDelta?.('searching sources', {
      sourceCount: searchSources.length,
      maxResults,
      vectorStoreIds,
    });

    const aggregatedResults: CodexProviderRelayFileSearchSourceMatch[] = [];
    let scannedFiles = 0;
    let skippedFiles = 0;
    for (const source of searchSources) {
      const sourceType = normalizeSourceType(source);
      await request.emitDelta?.('searching source', {
        source: source.name,
        sourceType,
      });
      const sourceResult = await source.search({
        query,
        terms,
        pathGlob,
        vectorStoreIds,
        filters,
        rankingOptions,
        maxResults,
        maxBytesPerFile: normalizedOptions.maxBytesPerFile,
        maxPayloadBytes: normalizedOptions.maxPayloadBytes,
        snippetLines: normalizedOptions.snippetLines,
        includeContent,
        emitDelta: request.emitDelta,
        toolRequest: request,
      });
      scannedFiles += normalizeNonNegativeInteger(sourceResult.scannedFiles);
      skippedFiles += normalizeNonNegativeInteger(sourceResult.skippedFiles);
      for (const result of sourceResult.results ?? []) {
        aggregatedResults.push(normalizeFileSearchResult(result, source, sourceType));
      }
    }

    const filteredResults = aggregatedResults.filter((result) => fileSearchResultMatchesFilter(result, filters));
    filteredResults.sort((left, right) => (
      right.score - left.score
      || String(left.source ?? '').localeCompare(String(right.source ?? ''))
      || left.path.localeCompare(right.path)
    ));
    const rankedResults = applyFileSearchRankingOptions(filteredResults, rankingOptions);
    const limitedResults = limitResultsByPayload(
      rankedResults,
      maxResults,
      normalizedOptions.maxPayloadBytes,
    );
    const openAIResults = limitedResults.map((result) => toOpenAIFileSearchResult(result, rankedResults));
    const provider = searchSources.length === 1
      ? normalizeSourceType(searchSources[0])
      : 'multi-source';
    return {
      content: {
        object: 'vector_store.search_results.page',
        query,
        search_query: query,
        provider,
        data: openAIResults,
        search_results: openAIResults,
        has_more: rankedResults.length > limitedResults.length,
        next_page: null,
        vector_store_ids: vectorStoreIds,
        ranking_options: rankingOptions,
        sourceCount: searchSources.length,
        scannedFiles,
        skippedFiles,
      } satisfies CodexProviderRelayFileSearchExecutorContent,
      metadata: {
        provider,
        sourceCount: searchSources.length,
        resultCount: limitedResults.length,
        scannedFiles,
        skippedFiles,
      },
    };
  };
}


function normalizeFileSearchOptions(
  options: CodexProviderRelayFileSearchExecutorOptions,
): NormalizedFileSearchOptions {
  const sources = normalizeFileSearchSources(options);
  if (sources.length === 0) {
    throw new Error('file_search executor requires at least one source or explicit root.');
  }
  return {
    sources,
    maxResults: clampInteger(options.maxResults, 1, 50, 8),
    maxBytesPerFile: clampInteger(options.maxBytesPerFile, 1_024, 2 * 1024 * 1024, 256 * 1024),
    maxPayloadBytes: clampInteger(options.maxPayloadBytes, 1_024, 2 * 1024 * 1024, 128 * 1024),
    snippetLines: clampInteger(options.snippetLines, 1, 8, 2),
    includeContent: typeof options.includeContent === 'boolean' ? options.includeContent : null,
  };
}

function normalizeFileSearchSources(
  options: CodexProviderRelayFileSearchExecutorOptions,
): CodexProviderRelayFileSearchSource[] {
  const sources: CodexProviderRelayFileSearchSource[] = [];
  if (Array.isArray(options.sources)) {
    for (const source of options.sources) {
      sources.push(normalizeFileSearchSource(source));
    }
  }
  if (Array.isArray(options.roots) && options.roots.length > 0) {
    sources.push(createCodexProviderRelayLocalFileSearchSource({
      roots: options.roots,
      maxFilesScanned: options.maxFilesScanned,
      maxBytesPerFile: options.maxBytesPerFile,
      snippetLines: options.snippetLines,
      includeContent: options.includeContent,
      followSymlinks: options.followSymlinks,
      ignoreDirectories: options.ignoreDirectories,
      ignoreExtensions: options.ignoreExtensions,
    }));
  }
  return sources;
}

function normalizeFileSearchSource(
  source: CodexProviderRelayFileSearchSourceInput,
): CodexProviderRelayFileSearchSource {
  if (source && typeof (source as CodexProviderRelayFileSearchSource).search === 'function') {
    const adapter = source as CodexProviderRelayFileSearchSource;
    const name = normalizeString(adapter.name);
    if (!name) {
      throw new Error('file_search source adapters require a non-empty name.');
    }
    return {
      ...adapter,
      name,
      type: normalizeString(adapter.type) || 'custom',
    };
  }
  if (
    source
    && Array.isArray((source as CodexProviderRelayLocalVectorFileSearchSourceOptions).roots)
    && (source as CodexProviderRelayLocalVectorFileSearchSourceOptions).embeddingProvider
  ) {
    return createCodexProviderRelayLocalVectorFileSearchSource(source as CodexProviderRelayLocalVectorFileSearchSourceOptions);
  }
  if (source && Array.isArray((source as CodexProviderRelayLocalFileSearchSourceOptions).roots)) {
    return createCodexProviderRelayLocalFileSearchSource(source as CodexProviderRelayLocalFileSearchSourceOptions);
  }
  if (
    source
    && Array.isArray((source as CodexProviderRelayInMemoryVectorFileSearchSourceOptions).documents)
    && (source as CodexProviderRelayInMemoryVectorFileSearchSourceOptions).embeddingProvider
  ) {
    return createCodexProviderRelayInMemoryVectorFileSearchSource(source as CodexProviderRelayInMemoryVectorFileSearchSourceOptions);
  }
  if (
    source
    && normalizeString((source as CodexProviderRelayVectorStoreFileSearchSourceOptions).type) === 'vector-store'
  ) {
    return createCodexProviderRelayVectorStoreFileSearchSource(source as CodexProviderRelayVectorStoreFileSearchSourceOptions);
  }
  if (
    source
    && normalizeString((source as CodexProviderRelayRemoteDocumentsFileSearchSourceOptions).type) === 'remote-documents'
  ) {
    return createCodexProviderRelayRemoteDocumentsFileSearchSource(source as CodexProviderRelayRemoteDocumentsFileSearchSourceOptions);
  }
  if (source && Array.isArray((source as CodexProviderRelayMemoryFileSearchSourceOptions).documents)) {
    return createCodexProviderRelayMemoryFileSearchSource(source as CodexProviderRelayMemoryFileSearchSourceOptions);
  }
  if (source && normalizeString((source as CodexProviderRelaySqliteFtsFileSearchSourceOptions).table)) {
    return createCodexProviderRelaySqliteFtsFileSearchSource(source as CodexProviderRelaySqliteFtsFileSearchSourceOptions);
  }
  throw new Error('file_search sources must be source adapters, local-fs source options, local-vector source options, memory-documents source options, sqlite-fts source options, in-memory-vector source options, vector-store source options, or remote-documents source options.');
}


function fileSearchQueryFromRequest(request: CodexProviderRelayHostedToolExecutionRequest): string {
  return firstNonEmptyString([
    request.arguments.query,
    request.arguments.q,
    request.arguments.search_query,
    request.arguments.input,
    request.rawArguments,
  ]);
}

function fileSearchMaxResultsFromRequest(
  request: CodexProviderRelayHostedToolExecutionRequest,
  fallback: number,
): number {
  return clampInteger(
    request.arguments.max_num_results ?? request.arguments.max_results,
    1,
    50,
    fallback,
  );
}

function selectFileSearchSources(
  sources: CodexProviderRelayFileSearchSource[],
  vectorStoreIds: string[],
): CodexProviderRelayFileSearchSource[] {
  if (vectorStoreIds.length === 0) {
    return sources;
  }
  const allowed = new Set(vectorStoreIds.map((entry) => entry.toLowerCase()));
  return sources.filter((source) => allowed.has(source.name.toLowerCase()));
}

function normalizeFileSearchRankingOptions(value: unknown): CodexProviderRelayFileSearchRankingOptions {
  const record = value && typeof value === 'object' ? value as JsonRecord : {};
  const hybridSearch = record.hybrid_search && typeof record.hybrid_search === 'object'
    ? record.hybrid_search as JsonRecord
    : null;
  return {
    ranker: normalizeString(record.ranker) || 'auto',
    scoreThreshold: clampNumber(record.score_threshold, 0, 1, 0),
    hybridSearch: hybridSearch
      ? {
        embeddingWeight: clampNumber(
          hybridSearch.embedding_weight ?? hybridSearch.rrf_embedding_weight,
          0,
          1,
          0.5,
        ),
        textWeight: clampNumber(
          hybridSearch.text_weight ?? hybridSearch.rrf_text_weight,
          0,
          1,
          0.5,
        ),
      }
      : null,
  };
}

function normalizeFileSearchFilter(value: unknown): CodexProviderRelayFileSearchFilter | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as JsonRecord;
  const type = normalizeString(record.type).toLowerCase();
  if ((type === 'and' || type === 'or') && Array.isArray(record.filters)) {
    const filters = record.filters.map(normalizeFileSearchFilter).filter(Boolean) as CodexProviderRelayFileSearchFilter[];
    return filters.length > 0 ? { type, filters } : null;
  }
  if (['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'].includes(type)) {
    const key = normalizeString(record.key ?? record.property);
    if (!key) {
      return null;
    }
    return {
      type: type as 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin',
      key: normalizeString(record.key) || null,
      property: normalizeString(record.property) || null,
      value: record.value,
    };
  }
  return null;
}

function fileSearchResultMatchesFilter(
  result: CodexProviderRelayFileSearchSourceMatch,
  filter: CodexProviderRelayFileSearchFilter | null,
): boolean {
  if (!filter) {
    return true;
  }
  if (filter.type === 'and') {
    return filter.filters.every((entry) => fileSearchResultMatchesFilter(result, entry));
  }
  if (filter.type === 'or') {
    return filter.filters.some((entry) => fileSearchResultMatchesFilter(result, entry));
  }
  const comparisonFilter = filter as Extract<CodexProviderRelayFileSearchFilter, { value: unknown }>;
  const key = normalizeString(comparisonFilter.key ?? comparisonFilter.property);
  const actual = fileSearchResultAttributeValue(result, key);
  switch (comparisonFilter.type) {
    case 'eq':
      return filterValueMatches(actual, comparisonFilter.value);
    case 'ne':
      return !filterValueMatches(actual, comparisonFilter.value);
    case 'gt':
      return compareFilterValues(actual, comparisonFilter.value) > 0;
    case 'gte':
      return compareFilterValues(actual, comparisonFilter.value) >= 0;
    case 'lt':
      return compareFilterValues(actual, comparisonFilter.value) < 0;
    case 'lte':
      return compareFilterValues(actual, comparisonFilter.value) <= 0;
    case 'in':
      return Array.isArray(comparisonFilter.value)
        ? comparisonFilter.value.some((value) => filterValueMatches(actual, value))
        : false;
    case 'nin':
      return Array.isArray(comparisonFilter.value)
        ? !comparisonFilter.value.some((value) => filterValueMatches(actual, value))
        : true;
    default:
      return true;
  }
}

function filterValueMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return actual.some((entry) => filterValueMatches(entry, expected));
  }
  if (Array.isArray(expected)) {
    return expected.some((entry) => filterValueMatches(actual, entry));
  }
  return compareFilterValues(actual, expected) === 0;
}

function fileSearchResultAttributeValue(result: CodexProviderRelayFileSearchSourceMatch, key: string): unknown {
  const attributes = result.attributes && typeof result.attributes === 'object'
    ? result.attributes
    : {};
  switch (key) {
    case 'file_id':
      return result.file_id;
    case 'filename':
      return result.filename;
    case 'path':
      return result.path;
    case 'source':
      return result.source;
    case 'source_type':
    case 'sourceType':
      return result.sourceType;
    default:
      return attributes[key];
  }
}

function compareFilterValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' || typeof right === 'number') {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
      return String(left ?? '').localeCompare(String(right ?? ''));
    }
    return leftNumber === rightNumber ? 0 : leftNumber > rightNumber ? 1 : -1;
  }
  const leftString = String(left ?? '');
  const rightString = String(right ?? '');
  return leftString === rightString ? 0 : leftString.localeCompare(rightString);
}

function applyFileSearchRankingOptions(
  results: CodexProviderRelayFileSearchSourceMatch[],
  rankingOptions: CodexProviderRelayFileSearchRankingOptions,
): CodexProviderRelayFileSearchSourceMatch[] {
  if (rankingOptions.scoreThreshold <= 0 || results.length === 0) {
    return results;
  }
  const maxScore = Math.max(...results.map((result) => result.score), 0);
  if (maxScore <= 0) {
    return [];
  }
  return results.filter((result) => result.score / maxScore >= rankingOptions.scoreThreshold);
}

function toOpenAIFileSearchResult(
  result: CodexProviderRelayFileSearchSourceMatch,
  rankedResults: CodexProviderRelayFileSearchSourceMatch[],
): CodexProviderRelayFileSearchResult {
  return {
    file_id: normalizeString(result.file_id) || stableFileSearchFileId(result.source ?? 'file_search', result.path),
    filename: normalizeString(result.filename) || path.basename(result.path) || result.title,
    score: normalizeOpenAIFileSearchScore(result, rankedResults),
    attributes: normalizeFileSearchAttributes(result.attributes),
    content: Array.isArray(result.content)
      ? result.content.map(normalizeFileSearchChunk).filter(Boolean) as CodexProviderRelayFileSearchChunk[]
      : [],
  };
}

function normalizeOpenAIFileSearchScore(
  result: CodexProviderRelayFileSearchSourceMatch,
  rankedResults: CodexProviderRelayFileSearchSourceMatch[],
): number {
  const maxScore = Math.max(...rankedResults.map((entry) => entry.score), 0);
  if (maxScore <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, Number((result.score / maxScore).toFixed(6))));
}

function normalizeFileSearchChunk(value: CodexProviderRelayFileSearchChunk): CodexProviderRelayFileSearchChunk | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const text = normalizeString(value.text);
  if (!text) {
    return null;
  }
  return {
    type: 'text',
    text,
    line: value.line ?? null,
    start_line: value.start_line ?? value.line ?? null,
    end_line: value.end_line ?? value.line ?? null,
  };
}


function normalizeSourceType(source: CodexProviderRelayFileSearchSource): string {
  return normalizeString(source.type) || 'custom';
}

function normalizeFileSearchResult(
  result: CodexProviderRelayFileSearchSourceMatch,
  source: CodexProviderRelayFileSearchSource,
  sourceType: string,
): CodexProviderRelayFileSearchSourceMatch {
  const normalizedPath = normalizeString(result.path) || normalizeString(result.title);
  const normalizedTitle = normalizeString(result.title) || normalizedPath || source.name;
  const filename = normalizeString(result.filename) || path.basename(normalizedPath) || normalizedTitle;
  const sourceName = normalizeString(result.source) || source.name;
  const normalizedSourceType = normalizeString(result.sourceType) || sourceType;
  const content = Array.isArray(result.content)
    ? result.content.map(normalizeFileSearchChunk).filter(Boolean) as CodexProviderRelayFileSearchChunk[]
    : [];
  const attributes = normalizeFileSearchAttributes({
    ...(result.attributes && typeof result.attributes === 'object' ? result.attributes : {}),
    filename,
    path: normalizedPath,
    source: sourceName,
    source_type: normalizedSourceType,
    ...(result.root ? { root: result.root } : {}),
  });
  return {
    file_id: normalizeString(result.file_id) || stableFileSearchFileId(sourceName, normalizedPath || normalizedTitle),
    filename,
    title: normalizedTitle,
    uri: normalizeString(result.uri),
    path: normalizedPath,
    root: result.root ?? null,
    source: sourceName,
    sourceType: normalizedSourceType,
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : 0,
    attributes,
    content,
  };
}

function limitResultsByPayload(
  results: CodexProviderRelayFileSearchSourceMatch[],
  maxResults: number,
  maxPayloadBytes: number,
): CodexProviderRelayFileSearchSourceMatch[] {
  const limited: CodexProviderRelayFileSearchSourceMatch[] = [];
  let payloadBytes = 0;
  for (const result of results) {
    if (limited.length >= maxResults) {
      break;
    }
    const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (limited.length > 0 && payloadBytes + resultBytes > maxPayloadBytes) {
      break;
    }
    limited.push(result);
    payloadBytes += resultBytes;
  }
  return limited;
}
