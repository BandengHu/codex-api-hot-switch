import path from 'node:path';
import type {
  CodexProviderRelayFileSearchSource,
  CodexProviderRelayFileSearchSourceMatch,
  CodexProviderRelayFileSearchSourceRequest,
  CodexProviderRelayFileSearchSourceResult,
  CodexProviderRelayMemoryFileSearchDocument,
  CodexProviderRelayMemoryFileSearchSourceOptions,
  NormalizedMemoryFileSearchDocument,
  NormalizedMemoryFileSearchOptions,
} from '../types.js';
import {
  clampInteger,
  firstNonEmptyString,
  normalizeRelativePath,
  normalizeString,
  pathMatchesGlob,
} from '../shared.js';
import { searchTextContent } from './local-shared.js';

export function createCodexProviderRelayMemoryFileSearchSource(
  options: CodexProviderRelayMemoryFileSearchSourceOptions,
): CodexProviderRelayFileSearchSource {
  const normalizedOptions = normalizeMemoryFileSearchOptions(options);
  return {
    name: normalizedOptions.name,
    type: 'memory-documents',
    async search(request: CodexProviderRelayFileSearchSourceRequest): Promise<CodexProviderRelayFileSearchSourceResult> {
      const maxResults = request.maxResults;
      const includeContent = typeof request.includeContent === 'boolean'
        ? request.includeContent
        : normalizedOptions.includeContent;
      const maxBytesPerDocument = Math.min(request.maxBytesPerFile, normalizedOptions.maxBytesPerDocument);
      const snippetLines = Math.min(request.snippetLines, normalizedOptions.snippetLines);

      await request.emitDelta?.('scanning memory documents', {
        source: normalizedOptions.name,
        documentCount: normalizedOptions.documents.length,
        maxResults,
      });

      const results: CodexProviderRelayFileSearchSourceMatch[] = [];
      let scannedDocuments = 0;
      let skippedDocuments = 0;
      for (const document of normalizedOptions.documents) {
        if (scannedDocuments >= normalizedOptions.maxDocumentsScanned || results.length >= maxResults) {
          break;
        }
        if (request.pathGlob && !pathMatchesGlob(document.path, request.pathGlob)) {
          continue;
        }
        const documentBytes = Buffer.byteLength(document.content, 'utf8');
        if (documentBytes > maxBytesPerDocument) {
          skippedDocuments += 1;
          continue;
        }
        scannedDocuments += 1;
        const result = searchTextContent({
          title: document.title,
          uri: document.uri,
          path: document.path,
          root: null,
          sourceName: normalizedOptions.name,
          sourceType: 'memory-documents',
          attributes: document.metadata,
          content: document.content,
          terms: request.terms,
          includeContent,
          snippetLines,
        });
        if (result) {
          results.push(result);
          await request.emitDelta?.('memory document matched', {
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
          provider: 'memory-documents',
          source: normalizedOptions.name,
          scannedDocuments,
          skippedDocuments,
        },
      };
    },
  };
}

function normalizeMemoryFileSearchOptions(
  options: CodexProviderRelayMemoryFileSearchSourceOptions,
): NormalizedMemoryFileSearchOptions {
  const documents = Array.isArray(options.documents)
    ? options.documents.map(normalizeMemoryFileSearchDocument).filter(Boolean)
    : [];
  return {
    name: normalizeString(options.name) || 'memory-documents',
    type: 'memory-documents',
    documents,
    maxDocumentsScanned: clampInteger(options.maxDocumentsScanned, 1, 100_000, 5_000),
    maxBytesPerDocument: clampInteger(options.maxBytesPerDocument, 1_024, 2 * 1024 * 1024, 256 * 1024),
    snippetLines: clampInteger(options.snippetLines, 1, 8, 2),
    includeContent: options.includeContent !== false,
  };
}

export function normalizeMemoryFileSearchDocument(
  document: CodexProviderRelayMemoryFileSearchDocument,
): NormalizedMemoryFileSearchDocument | null {
  if (!document || typeof document !== 'object') {
    return null;
  }
  const id = normalizeString(document.id);
  const content = normalizeString(document.content);
  if (!id || !content) {
    return null;
  }
  const pathValue = normalizeRelativePath(firstNonEmptyString([
    document.path,
    document.title,
    id,
  ]));
  const safePath = pathValue && !path.isAbsolute(pathValue) && !pathValue.split('/').includes('..')
    ? pathValue
    : `memory/${id}`;
  return {
    id,
    title: firstNonEmptyString([document.title, safePath, id]),
    uri: normalizeString(document.uri) || `memory://${encodeURIComponent(id)}`,
    path: safePath,
    content,
    metadata: document.metadata && typeof document.metadata === 'object'
      ? document.metadata
      : null,
  };
}

export function embeddingTextForMemoryDocument(document: NormalizedMemoryFileSearchDocument): string {
  return [
    document.title,
    document.path,
    document.content,
  ].filter(Boolean).join('\n\n');
}
