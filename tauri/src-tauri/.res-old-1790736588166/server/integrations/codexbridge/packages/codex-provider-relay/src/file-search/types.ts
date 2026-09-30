import type {
  CodexProviderRelayHostedToolDeltaEmitter,
  CodexProviderRelayHostedToolExecutionRequest,
  CodexProviderRelayHostedToolExecutionResult,
  CodexProviderRelayHostedToolExecutor,
  JsonRecord,
} from '../hosted_tool_executors.js';

export type {
  CodexProviderRelayHostedToolDeltaEmitter,
  CodexProviderRelayHostedToolExecutionRequest,
  CodexProviderRelayHostedToolExecutionResult,
  CodexProviderRelayHostedToolExecutor,
  JsonRecord,
} from '../hosted_tool_executors.js';

export interface CodexProviderRelayFileSearchExecutorOptions {
  roots?: string[] | null;
  sources?: CodexProviderRelayFileSearchSourceInput[] | null;
  maxResults?: number | null;
  maxFilesScanned?: number | null;
  maxBytesPerFile?: number | null;
  maxPayloadBytes?: number | null;
  snippetLines?: number | null;
  includeContent?: boolean | null;
  followSymlinks?: boolean | null;
  ignoreDirectories?: string[] | null;
  ignoreExtensions?: string[] | null;
}

export type CodexProviderRelayFileSearchSourceInput =
  | CodexProviderRelayFileSearchSource
  | CodexProviderRelayLocalFileSearchSourceOptions
  | CodexProviderRelayLocalVectorFileSearchSourceOptions
  | CodexProviderRelayMemoryFileSearchSourceOptions
  | CodexProviderRelaySqliteFtsFileSearchSourceOptions
  | CodexProviderRelayInMemoryVectorFileSearchSourceOptions
  | CodexProviderRelayVectorStoreFileSearchSourceOptions
  | CodexProviderRelayRemoteDocumentsFileSearchSourceOptions;

export interface CodexProviderRelayFileSearchSource {
  name: string;
  type?: string | null;
  search(
    request: CodexProviderRelayFileSearchSourceRequest,
  ): Promise<CodexProviderRelayFileSearchSourceResult> | CodexProviderRelayFileSearchSourceResult;
}

export interface CodexProviderRelayFileSearchSourceRequest {
  query: string;
  terms: string[];
  pathGlob: string;
  vectorStoreIds: string[];
  filters: CodexProviderRelayFileSearchFilter | null;
  rankingOptions: CodexProviderRelayFileSearchRankingOptions;
  maxResults: number;
  maxBytesPerFile: number;
  maxPayloadBytes: number;
  snippetLines: number;
  includeContent: boolean | null;
  emitDelta?: CodexProviderRelayHostedToolDeltaEmitter | null;
  toolRequest: CodexProviderRelayHostedToolExecutionRequest;
}

export interface CodexProviderRelayFileSearchSourceResult {
  results: CodexProviderRelayFileSearchSourceMatch[];
  scannedFiles?: number | null;
  skippedFiles?: number | null;
  metadata?: JsonRecord | null;
}

export interface CodexProviderRelayVectorStoreFileSearchSourceOptions {
  type?: 'vector-store' | null;
  name?: string | null;
  store: CodexProviderRelayVectorStoreAdapter;
}

export interface CodexProviderRelayVectorStoreAdapter {
  search(
    request: CodexProviderRelayVectorStoreSearchRequest,
  ): Promise<CodexProviderRelayFileSearchSourceResult> | CodexProviderRelayFileSearchSourceResult;
}

export interface CodexProviderRelayVectorStoreSearchRequest {
  sourceName: string;
  query: string;
  terms: string[];
  pathGlob: string;
  vectorStoreIds: string[];
  filters: CodexProviderRelayFileSearchFilter | null;
  rankingOptions: CodexProviderRelayFileSearchRankingOptions;
  maxResults: number;
  maxBytesPerFile: number;
  maxPayloadBytes: number;
  snippetLines: number;
  includeContent: boolean | null;
  toolRequest: CodexProviderRelayHostedToolExecutionRequest;
}

export interface CodexProviderRelayRemoteDocumentsFileSearchSourceOptions {
  type?: 'remote-documents' | null;
  name?: string | null;
  query: CodexProviderRelayRemoteDocumentsQueryFunction;
  fetchDocument?: CodexProviderRelayRemoteDocumentsFetchFunction | null;
  maxDocumentsScanned?: number | null;
  maxBytesPerDocument?: number | null;
  snippetLines?: number | null;
  includeContent?: boolean | null;
}

export type CodexProviderRelayRemoteDocumentsQueryFunction = (
  request: CodexProviderRelayRemoteDocumentsQueryRequest,
) => Promise<CodexProviderRelayRemoteDocument[]> | CodexProviderRelayRemoteDocument[];

export type CodexProviderRelayRemoteDocumentsFetchFunction = (
  request: CodexProviderRelayRemoteDocumentsFetchRequest,
) => Promise<string | CodexProviderRelayRemoteDocument | null> | string | CodexProviderRelayRemoteDocument | null;

export interface CodexProviderRelayRemoteDocumentsQueryRequest {
  sourceName: string;
  query: string;
  terms: string[];
  pathGlob: string;
  vectorStoreIds: string[];
  filters: CodexProviderRelayFileSearchFilter | null;
  rankingOptions: CodexProviderRelayFileSearchRankingOptions;
  maxResults: number;
  includeContent: boolean | null;
  toolRequest: CodexProviderRelayHostedToolExecutionRequest;
}

export interface CodexProviderRelayRemoteDocumentsFetchRequest extends CodexProviderRelayRemoteDocumentsQueryRequest {
  document: CodexProviderRelayRemoteDocument;
}

export interface CodexProviderRelayRemoteDocument {
  id: string;
  title?: string | null;
  uri?: string | null;
  path?: string | null;
  content?: string | null;
  snippet?: string | null;
  score?: number | null;
  metadata?: JsonRecord | null;
}

export interface CodexProviderRelayLocalFileSearchSourceOptions {
  type?: 'local-fs' | null;
  name?: string | null;
  roots: string[];
  maxFilesScanned?: number | null;
  maxBytesPerFile?: number | null;
  snippetLines?: number | null;
  includeContent?: boolean | null;
  followSymlinks?: boolean | null;
  ignoreDirectories?: string[] | null;
  ignoreExtensions?: string[] | null;
}

export interface CodexProviderRelayMemoryFileSearchSourceOptions {
  type?: 'memory-documents' | null;
  name?: string | null;
  documents: CodexProviderRelayMemoryFileSearchDocument[];
  maxDocumentsScanned?: number | null;
  maxBytesPerDocument?: number | null;
  snippetLines?: number | null;
  includeContent?: boolean | null;
}

export interface CodexProviderRelayMemoryFileSearchDocument {
  id: string;
  title?: string | null;
  uri?: string | null;
  path?: string | null;
  content: string;
  metadata?: JsonRecord | null;
}

export interface CodexProviderRelaySqliteFtsFileSearchSourceOptions {
  type?: 'sqlite-fts' | null;
  name?: string | null;
  table: string;
  database?: CodexProviderRelaySqliteFtsDatabase | null;
  query?: CodexProviderRelaySqliteFtsQueryFunction | null;
  columns?: CodexProviderRelaySqliteFtsColumns | null;
  metadataColumns?: string[] | null;
  maxRows?: number | null;
  maxBytesPerDocument?: number | null;
  snippetLines?: number | null;
  includeContent?: boolean | null;
}

export interface CodexProviderRelaySqliteFtsDatabase {
  all(sql: string, params: unknown[]): Promise<JsonRecord[]> | JsonRecord[];
}

export type CodexProviderRelaySqliteFtsQueryFunction = (
  request: CodexProviderRelaySqliteFtsQueryRequest,
) => Promise<JsonRecord[]> | JsonRecord[];

export interface CodexProviderRelaySqliteFtsQueryRequest {
  sql: string;
  params: unknown[];
  query: string;
  ftsQuery: string;
  pathGlob: string;
  maxResults: number;
  terms: string[];
}

export interface CodexProviderRelaySqliteFtsColumns {
  id?: string | null;
  title?: string | null;
  uri?: string | null;
  path?: string | null;
  content?: string | null;
  score?: string | null;
}

export interface CodexProviderRelayEmbeddingProvider {
  model: string;
  embed(
    input: string[],
    options?: CodexProviderRelayEmbeddingProviderEmbedOptions,
  ): Promise<CodexProviderRelayEmbeddingProviderResult> | CodexProviderRelayEmbeddingProviderResult;
}

export interface CodexProviderRelayEmbeddingProviderEmbedOptions {
  signal?: AbortSignal | null;
}

export interface CodexProviderRelayEmbeddingProviderResult {
  model: string;
  embeddings: number[][];
  dimensions?: number | null;
}

export type CodexProviderRelayEmbeddingsApiResponseParser = (body: JsonRecord) => number[][];

export interface CodexProviderRelayEmbeddingsApiProviderOptions {
  apiKey?: string | null;
  model?: string | null;
  endpoint?: string | null;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string> | null;
  requestBody?: JsonRecord | null;
  responseParser?: CodexProviderRelayEmbeddingsApiResponseParser | null;
}

export interface CodexProviderRelayOpenRouterEmbeddingProviderOptions
  extends Omit<CodexProviderRelayEmbeddingsApiProviderOptions, 'endpoint' | 'model'> {
  model?: string | null;
  endpoint?: string | null;
}

export interface CodexProviderRelayLocalVectorChunkingOptions {
  maxChars?: number | null;
  overlapChars?: number | null;
  maxChunksPerFile?: number | null;
}

export interface CodexProviderRelayLocalVectorFileSearchSourceOptions
  extends Omit<CodexProviderRelayLocalFileSearchSourceOptions, 'type'> {
  type?: 'local-vector' | null;
  embeddingProvider: CodexProviderRelayEmbeddingProvider;
  indexStore?: CodexProviderRelayLocalVectorIndexStore | null;
  chunking?: CodexProviderRelayLocalVectorChunkingOptions | null;
  vectorWeight?: number | null;
  textWeight?: number | null;
  embeddingBatchSize?: number | null;
}

export interface CodexProviderRelayLocalVectorIndexDocument {
  id: string;
  sourceName: string;
  root: string;
  path: string;
  uri: string;
  title: string;
  filename: string;
  size: number;
  mtimeMs: number;
  contentHash: string;
  embeddingModel: string;
  indexVersion?: string | null;
  chunkerVersion?: string | null;
  chunkingConfigHash?: string | null;
  embeddingDimensions?: number | null;
  contentHashAlgorithm?: string | null;
  statFingerprint?: string | null;
  updatedAt: string;
}

export interface CodexProviderRelayLocalVectorIndexChunk {
  id: string;
  documentId: string;
  sourceName: string;
  root: string;
  path: string;
  uri: string;
  title: string;
  filename: string;
  text: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: number[];
  metadata?: JsonRecord | null;
}

export interface CodexProviderRelayLocalVectorIndexSearchChunksRequest {
  sourceName: string;
  query: string;
  terms: string[];
  pathGlob: string;
  queryEmbedding: number[];
  maxResults: number;
  rankingOptions: CodexProviderRelayFileSearchRankingOptions;
}

export interface CodexProviderRelayLocalVectorIndexStore {
  getDocument(
    id: string,
  ): Promise<CodexProviderRelayLocalVectorIndexDocument | null> | CodexProviderRelayLocalVectorIndexDocument | null;
  upsertDocument(
    document: CodexProviderRelayLocalVectorIndexDocument,
    chunks: CodexProviderRelayLocalVectorIndexChunk[],
  ): Promise<void> | void;
  listChunks(
    sourceName: string,
  ): Promise<CodexProviderRelayLocalVectorIndexChunk[]> | CodexProviderRelayLocalVectorIndexChunk[];
  listDocuments?(
    sourceName: string,
  ): Promise<CodexProviderRelayLocalVectorIndexDocument[]> | CodexProviderRelayLocalVectorIndexDocument[];
  searchChunks?(
    request: CodexProviderRelayLocalVectorIndexSearchChunksRequest,
  ): Promise<CodexProviderRelayLocalVectorIndexChunk[]> | CodexProviderRelayLocalVectorIndexChunk[];
  deleteDocuments?(ids: string[]): Promise<void> | void;
  deleteStaleDocuments?(sourceName: string, liveDocumentIds: string[]): Promise<string[]> | string[];
}

export interface CodexProviderRelaySqliteLocalVectorIndexStoreDatabase {
  all(sql: string, params?: unknown[]): Promise<JsonRecord[]> | JsonRecord[];
  run(sql: string, params?: unknown[]): Promise<unknown> | unknown;
}

export interface CodexProviderRelaySqliteLocalVectorIndexStoreQueryRequest {
  operation: 'all' | 'run';
  sql: string;
  params: unknown[];
}

export type CodexProviderRelaySqliteLocalVectorIndexStoreQueryFunction = (
  request: CodexProviderRelaySqliteLocalVectorIndexStoreQueryRequest,
) => Promise<unknown> | unknown;

export interface CodexProviderRelaySqliteLocalVectorIndexStoreOptions {
  database?: CodexProviderRelaySqliteLocalVectorIndexStoreDatabase | null;
  query?: CodexProviderRelaySqliteLocalVectorIndexStoreQueryFunction | null;
  tablePrefix?: string | null;
  initializeSchema?: boolean | null;
}

export interface CodexProviderRelayInMemoryVectorFileSearchSourceOptions {
  type?: 'in-memory-vector' | null;
  name?: string | null;
  documents: CodexProviderRelayMemoryFileSearchDocument[];
  embeddingProvider: CodexProviderRelayEmbeddingProvider;
  maxDocumentsScanned?: number | null;
  maxBytesPerDocument?: number | null;
  snippetLines?: number | null;
  includeContent?: boolean | null;
  vectorWeight?: number | null;
  textWeight?: number | null;
}

export interface CodexProviderRelayFileSearchSourceMatch {
  file_id?: string | null;
  filename?: string | null;
  title: string;
  uri: string;
  path: string;
  root?: string | null;
  source?: string | null;
  sourceType?: string | null;
  score: number;
  attributes?: JsonRecord | null;
  content?: CodexProviderRelayFileSearchChunk[] | null;
}

export interface CodexProviderRelayFileSearchDocument {
  file_id: string;
  filename: string;
  title: string;
  uri: string;
  path: string;
  root?: string | null;
  source?: string | null;
  sourceType?: string | null;
  attributes: JsonRecord;
}

export interface CodexProviderRelayFileSearchChunk {
  type: 'text';
  text: string;
  line?: number | null;
  start_line?: number | null;
  end_line?: number | null;
}

export interface CodexProviderRelayFileSearchResult {
  file_id: string;
  filename: string;
  score: number;
  attributes: JsonRecord;
  content: CodexProviderRelayFileSearchChunk[];
}

export type CodexProviderRelayFileSearchFilter =
  | {
    type: 'and' | 'or';
    filters: CodexProviderRelayFileSearchFilter[];
  }
  | {
    type: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin';
    key?: string | null;
    property?: string | null;
    value: unknown;
  };

export interface CodexProviderRelayFileSearchRankingOptions {
  ranker: string;
  scoreThreshold: number;
  hybridSearch: {
    embeddingWeight: number;
    textWeight: number;
  } | null;
}

export interface CodexProviderRelayFileSearchExecutorContent {
  object: 'vector_store.search_results.page';
  query: string;
  search_query: string;
  provider: string;
  data: CodexProviderRelayFileSearchResult[];
  search_results: CodexProviderRelayFileSearchResult[];
  has_more: boolean;
  next_page: string | null;
  vector_store_ids: string[];
  ranking_options: CodexProviderRelayFileSearchRankingOptions;
  sourceCount: number;
  scannedFiles: number;
  skippedFiles: number;
}

export interface NormalizedFileSearchOptions {
  sources: CodexProviderRelayFileSearchSource[];
  maxResults: number;
  maxBytesPerFile: number;
  maxPayloadBytes: number;
  snippetLines: number;
  includeContent: boolean | null;
}

export interface NormalizedRemoteDocumentsFileSearchOptions {
  name: string;
  type: 'remote-documents';
  query: CodexProviderRelayRemoteDocumentsQueryFunction;
  fetchDocument: CodexProviderRelayRemoteDocumentsFetchFunction | null;
  maxDocumentsScanned: number;
  maxBytesPerDocument: number;
  snippetLines: number;
  includeContent: boolean;
}

export interface NormalizedLocalFileSearchOptions {
  name: string;
  type: 'local-fs';
  roots: LocalFileSearchRoot[];
  maxFilesScanned: number;
  maxBytesPerFile: number;
  snippetLines: number;
  includeContent: boolean;
  followSymlinks: boolean;
  ignoreDirectories: Set<string>;
  ignoreExtensions: Set<string>;
}

export interface NormalizedMemoryFileSearchOptions {
  name: string;
  type: 'memory-documents';
  documents: NormalizedMemoryFileSearchDocument[];
  maxDocumentsScanned: number;
  maxBytesPerDocument: number;
  snippetLines: number;
  includeContent: boolean;
}

export interface NormalizedMemoryFileSearchDocument {
  id: string;
  title: string;
  uri: string;
  path: string;
  content: string;
  metadata: JsonRecord | null;
}

export interface NormalizedSqliteFtsFileSearchOptions {
  name: string;
  type: 'sqlite-fts';
  table: string;
  tableMatchTarget: string;
  query: CodexProviderRelaySqliteFtsQueryFunction;
  columns: Required<CodexProviderRelaySqliteFtsColumns>;
  metadataColumns: string[];
  maxRows: number;
  maxBytesPerDocument: number;
  snippetLines: number;
  includeContent: boolean;
}

export interface NormalizedInMemoryVectorFileSearchOptions {
  name: string;
  type: 'in-memory-vector';
  documents: NormalizedMemoryFileSearchDocument[];
  embeddingProvider: CodexProviderRelayEmbeddingProvider;
  maxDocumentsScanned: number;
  maxBytesPerDocument: number;
  snippetLines: number;
  includeContent: boolean;
  vectorWeight: number;
  textWeight: number;
}

export interface NormalizedLocalVectorFileSearchOptions {
  local: NormalizedLocalFileSearchOptions;
  name: string;
  type: 'local-vector';
  embeddingProvider: CodexProviderRelayEmbeddingProvider;
  indexStore: CodexProviderRelayLocalVectorIndexStore;
  chunking: NormalizedLocalVectorChunkingOptions;
  vectorWeight: number;
  textWeight: number;
  embeddingBatchSize: number;
}

export interface NormalizedLocalVectorChunkingOptions {
  maxChars: number;
  overlapChars: number;
  maxChunksPerFile: number;
}

export interface EmbeddedMemoryFileSearchDocument {
  document: NormalizedMemoryFileSearchDocument;
  embedding: number[];
}

export interface LocalVectorTextChunk {
  text: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
}

export interface LocalFileSearchRoot {
  path: string;
  realPath: string;
}

export interface CandidateFile {
  root: LocalFileSearchRoot;
  absolutePath: string;
  relativePath: string;
}
