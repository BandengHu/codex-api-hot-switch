import type {
  CodexProviderRelayFileSearchSource,
  CodexProviderRelayFileSearchSourceRequest,
  CodexProviderRelayFileSearchSourceResult,
  CodexProviderRelayVectorStoreFileSearchSourceOptions,
} from '../types.js';
import {
  normalizeString,
} from '../shared.js';

export function createCodexProviderRelayVectorStoreFileSearchSource(
  options: CodexProviderRelayVectorStoreFileSearchSourceOptions,
): CodexProviderRelayFileSearchSource {
  const store = options.store;
  if (!store || typeof store.search !== 'function') {
    throw new Error('vector-store file_search source requires a store adapter with search().');
  }
  const name = normalizeString(options.name) || 'vector-store';
  return {
    name,
    type: 'vector-store',
    async search(request: CodexProviderRelayFileSearchSourceRequest): Promise<CodexProviderRelayFileSearchSourceResult> {
      await request.emitDelta?.('querying vector store adapter', {
        source: name,
        vectorStoreIds: request.vectorStoreIds,
        maxResults: request.maxResults,
      });
      return store.search({
        sourceName: name,
        query: request.query,
        terms: request.terms,
        pathGlob: request.pathGlob,
        vectorStoreIds: request.vectorStoreIds,
        filters: request.filters,
        rankingOptions: request.rankingOptions,
        maxResults: request.maxResults,
        maxBytesPerFile: request.maxBytesPerFile,
        maxPayloadBytes: request.maxPayloadBytes,
        snippetLines: request.snippetLines,
        includeContent: request.includeContent,
        toolRequest: request.toolRequest,
      });
    },
  };
}
