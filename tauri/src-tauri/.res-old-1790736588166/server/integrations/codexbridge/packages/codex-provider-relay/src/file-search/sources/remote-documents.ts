import path from 'node:path';
import type {
  CodexProviderRelayFileSearchSource,
  CodexProviderRelayFileSearchSourceMatch,
  CodexProviderRelayFileSearchSourceRequest,
  CodexProviderRelayFileSearchSourceResult,
  CodexProviderRelayRemoteDocument,
  CodexProviderRelayRemoteDocumentsFileSearchSourceOptions,
  NormalizedMemoryFileSearchDocument,
  NormalizedRemoteDocumentsFileSearchOptions,
} from '../types.js';
import {
  clampInteger,
  contentChunksForTerms,
  firstNonEmptyString,
  lexicalScoreForText,
  normalizeFileSearchAttributes,
  normalizeRelativePath,
  normalizeString,
  pathMatchesGlob,
  stableFileSearchFileId,
} from '../shared.js';

export function createCodexProviderRelayRemoteDocumentsFileSearchSource(
  options: CodexProviderRelayRemoteDocumentsFileSearchSourceOptions,
): CodexProviderRelayFileSearchSource {
  const normalizedOptions = normalizeRemoteDocumentsFileSearchOptions(options);
  return {
    name: normalizedOptions.name,
    type: 'remote-documents',
    async search(request: CodexProviderRelayFileSearchSourceRequest): Promise<CodexProviderRelayFileSearchSourceResult> {
      const maxResults = request.maxResults;
      const includeContent = typeof request.includeContent === 'boolean'
        ? request.includeContent
        : normalizedOptions.includeContent;
      const snippetLines = Math.min(request.snippetLines, normalizedOptions.snippetLines);
      await request.emitDelta?.('querying remote documents', {
        source: normalizedOptions.name,
        maxResults,
      });

      const documents = await normalizedOptions.query({
        sourceName: normalizedOptions.name,
        query: request.query,
        terms: request.terms,
        pathGlob: request.pathGlob,
        vectorStoreIds: request.vectorStoreIds,
        filters: request.filters,
        rankingOptions: request.rankingOptions,
        maxResults,
        includeContent,
        toolRequest: request.toolRequest,
      });
      const results: CodexProviderRelayFileSearchSourceMatch[] = [];
      let scannedDocuments = 0;
      let skippedDocuments = 0;
      for (const rawDocument of Array.isArray(documents) ? documents : []) {
        if (scannedDocuments >= normalizedOptions.maxDocumentsScanned || results.length >= maxResults) {
          break;
        }
        const normalizedDocument = normalizeRemoteDocument(rawDocument);
        if (!normalizedDocument) {
          skippedDocuments += 1;
          continue;
        }
        if (request.pathGlob && !pathMatchesGlob(normalizedDocument.path, request.pathGlob)) {
          continue;
        }
        scannedDocuments += 1;
        const hydratedDocument = includeContent
          ? await hydrateRemoteDocument({
            options: normalizedOptions,
            rawDocument,
            normalizedDocument,
            request,
            includeContent,
            maxResults,
          })
          : normalizedDocument;
        const documentBytes = Buffer.byteLength(hydratedDocument.content, 'utf8');
        if (documentBytes > normalizedOptions.maxBytesPerDocument) {
          skippedDocuments += 1;
          continue;
        }
        const result = remoteDocumentToMatch({
          document: hydratedDocument,
          rawDocument,
          sourceName: normalizedOptions.name,
          terms: request.terms,
          includeContent,
          snippetLines,
        });
        if (result) {
          results.push(result);
          await request.emitDelta?.('remote document matched', {
            source: normalizedOptions.name,
            path: result.path,
            score: result.score,
            resultCount: results.length,
          });
        }
      }

      results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
      return {
        results: results.slice(0, maxResults),
        scannedFiles: scannedDocuments,
        skippedFiles: skippedDocuments,
        metadata: {
          provider: 'remote-documents',
          source: normalizedOptions.name,
          scannedDocuments,
          skippedDocuments,
        },
      };
    },
  };
}

function normalizeRemoteDocumentsFileSearchOptions(
  options: CodexProviderRelayRemoteDocumentsFileSearchSourceOptions,
): NormalizedRemoteDocumentsFileSearchOptions {
  if (!options.query || typeof options.query !== 'function') {
    throw new Error('remote-documents file_search source requires a query function.');
  }
  return {
    name: normalizeString(options.name) || 'remote-documents',
    type: 'remote-documents',
    query: options.query,
    fetchDocument: typeof options.fetchDocument === 'function' ? options.fetchDocument : null,
    maxDocumentsScanned: clampInteger(options.maxDocumentsScanned, 1, 100_000, 5_000),
    maxBytesPerDocument: clampInteger(options.maxBytesPerDocument, 1_024, 2 * 1024 * 1024, 256 * 1024),
    snippetLines: clampInteger(options.snippetLines, 1, 8, 2),
    includeContent: options.includeContent !== false,
  };
}

function normalizeRemoteDocument(document: CodexProviderRelayRemoteDocument): NormalizedMemoryFileSearchDocument | null {
  if (!document || typeof document !== 'object') {
    return null;
  }
  const id = normalizeString(document.id);
  if (!id) {
    return null;
  }
  const pathValue = normalizeRelativePath(firstNonEmptyString([
    document.path,
    document.title,
    id,
  ]));
  const safePath = pathValue && !path.isAbsolute(pathValue) && !pathValue.split('/').includes('..')
    ? pathValue
    : `remote/${id}`;
  const content = firstNonEmptyString([
    document.content,
    document.snippet,
    document.title,
  ]);
  return {
    id,
    title: firstNonEmptyString([document.title, safePath, id]),
    uri: normalizeString(document.uri) || `remote://${encodeURIComponent(id)}`,
    path: safePath,
    content,
    metadata: document.metadata && typeof document.metadata === 'object'
      ? document.metadata
      : null,
  };
}

async function hydrateRemoteDocument({
  options,
  rawDocument,
  normalizedDocument,
  request,
  includeContent,
  maxResults,
}: {
  options: NormalizedRemoteDocumentsFileSearchOptions;
  rawDocument: CodexProviderRelayRemoteDocument;
  normalizedDocument: NormalizedMemoryFileSearchDocument;
  request: CodexProviderRelayFileSearchSourceRequest;
  includeContent: boolean;
  maxResults: number;
}): Promise<NormalizedMemoryFileSearchDocument> {
  if (!options.fetchDocument || normalizeString(rawDocument.content)) {
    return normalizedDocument;
  }
  const fetched = await options.fetchDocument({
    sourceName: options.name,
    query: request.query,
    terms: request.terms,
    pathGlob: request.pathGlob,
    vectorStoreIds: request.vectorStoreIds,
    filters: request.filters,
    rankingOptions: request.rankingOptions,
    maxResults,
    includeContent,
    toolRequest: request.toolRequest,
    document: rawDocument,
  });
  if (typeof fetched === 'string') {
    return {
      ...normalizedDocument,
      content: fetched || normalizedDocument.content,
    };
  }
  if (fetched && typeof fetched === 'object') {
    return normalizeRemoteDocument({
      ...rawDocument,
      ...fetched,
      id: normalizeString(fetched.id) || rawDocument.id,
    }) ?? normalizedDocument;
  }
  return normalizedDocument;
}

function remoteDocumentToMatch({
  document,
  rawDocument,
  sourceName,
  terms,
  includeContent,
  snippetLines,
}: {
  document: NormalizedMemoryFileSearchDocument;
  rawDocument: CodexProviderRelayRemoteDocument;
  sourceName: string;
  terms: string[];
  includeContent: boolean;
  snippetLines: number;
}): CodexProviderRelayFileSearchSourceMatch | null {
  const lexicalScore = lexicalScoreForText({
    title: document.title,
    path: document.path,
    content: document.content,
    terms,
  });
  const score = Number.isFinite(Number(rawDocument.score))
    ? Number(rawDocument.score)
    : lexicalScore;
  if (score <= 0) {
    return null;
  }
  const filename = path.basename(document.path) || document.title;
  return {
    file_id: stableFileSearchFileId(sourceName, document.path || document.id),
    filename,
    title: document.title,
    uri: document.uri,
    path: document.path,
    root: null,
    source: sourceName,
    sourceType: 'remote-documents',
    score,
    attributes: normalizeFileSearchAttributes({
      ...(document.metadata && typeof document.metadata === 'object' ? document.metadata : {}),
      filename,
      path: document.path,
      source: sourceName,
      source_type: 'remote-documents',
      ...(normalizeString(rawDocument.id) ? { remote_id: normalizeString(rawDocument.id) } : {}),
    }),
    content: includeContent
      ? contentChunksForTerms({
        content: document.content,
        terms,
        snippetLines,
      })
      : [],
  };
}
