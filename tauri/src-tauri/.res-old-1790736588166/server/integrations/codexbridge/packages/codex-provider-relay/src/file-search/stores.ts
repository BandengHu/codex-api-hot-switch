import type {
  CodexProviderRelayLocalVectorIndexChunk,
  CodexProviderRelayLocalVectorIndexDocument,
  CodexProviderRelayLocalVectorIndexStore,
  CodexProviderRelaySqliteLocalVectorIndexStoreOptions,
  CodexProviderRelaySqliteLocalVectorIndexStoreQueryFunction,
  CodexProviderRelaySqliteLocalVectorIndexStoreQueryRequest,
  JsonRecord,
} from './types.js';
import {
  normalizeEmbeddingVector,
  normalizeFileSearchAttributes,
  normalizeNonNegativeInteger,
  normalizeSqlIdentifier,
  normalizeSqliteTablePrefix,
  normalizeString,
  parseJsonArrayOrEmpty,
  parseJsonRecordOrNull,
} from './shared.js';

export function createCodexProviderRelayMemoryLocalVectorIndexStore(): CodexProviderRelayLocalVectorIndexStore {
  const documents = new Map<string, CodexProviderRelayLocalVectorIndexDocument>();
  const chunksByDocument = new Map<string, CodexProviderRelayLocalVectorIndexChunk[]>();
  return {
    getDocument(id: string): CodexProviderRelayLocalVectorIndexDocument | null {
      return documents.get(id) ?? null;
    },
    upsertDocument(
      document: CodexProviderRelayLocalVectorIndexDocument,
      chunks: CodexProviderRelayLocalVectorIndexChunk[],
    ): void {
      documents.set(document.id, document);
      chunksByDocument.set(document.id, chunks);
    },
    listChunks(sourceName: string): CodexProviderRelayLocalVectorIndexChunk[] {
      const chunks: CodexProviderRelayLocalVectorIndexChunk[] = [];
      for (const document of documents.values()) {
        if (document.sourceName === sourceName) {
          chunks.push(...(chunksByDocument.get(document.id) ?? []));
        }
      }
      return chunks;
    },
    listDocuments(sourceName: string): CodexProviderRelayLocalVectorIndexDocument[] {
      return [...documents.values()]
        .filter((document) => document.sourceName === sourceName)
        .sort((left, right) => left.path.localeCompare(right.path));
    },
    deleteDocuments(ids: string[]): void {
      for (const id of ids) {
        documents.delete(id);
        chunksByDocument.delete(id);
      }
    },
    deleteStaleDocuments(sourceName: string, liveDocumentIds: string[]): string[] {
      const liveIds = new Set(liveDocumentIds);
      const staleIds = [...documents.values()]
        .filter((document) => document.sourceName === sourceName && !liveIds.has(document.id))
        .map((document) => document.id);
      for (const id of staleIds) {
        documents.delete(id);
        chunksByDocument.delete(id);
      }
      return staleIds;
    },
  };
}

export function createCodexProviderRelaySqliteLocalVectorIndexStore(
  options: CodexProviderRelaySqliteLocalVectorIndexStoreOptions,
): CodexProviderRelayLocalVectorIndexStore {
  const query = normalizeSqliteLocalVectorIndexStoreQuery(options);
  const tablePrefix = normalizeSqliteTablePrefix(options.tablePrefix, 'codex_provider_relay_local_vector');
  const documentsTable = normalizeSqlIdentifier(`${tablePrefix}_documents`, 'sqlite local-vector documents table');
  const chunksTable = normalizeSqlIdentifier(`${tablePrefix}_chunks`, 'sqlite local-vector chunks table');
  const chunksSourceIndex = normalizeSqlIdentifier(`${tablePrefix}_chunks_source_path_idx`, 'sqlite local-vector source index');
  const chunksDocumentIndex = normalizeSqlIdentifier(`${tablePrefix}_chunks_document_idx`, 'sqlite local-vector document index');
  const shouldInitialize = options.initializeSchema !== false;
  let initializationPromise: Promise<void> | null = null;

  async function ensureInitialized(): Promise<void> {
    if (!shouldInitialize) {
      return;
    }
    initializationPromise ??= initializeSqliteLocalVectorIndexStore({
      query,
      documentsTable,
      chunksTable,
      chunksSourceIndex,
      chunksDocumentIndex,
    });
    await initializationPromise;
  }

  return {
    async getDocument(id: string): Promise<CodexProviderRelayLocalVectorIndexDocument | null> {
      await ensureInitialized();
      const rows = await sqliteLocalVectorAll(query, {
        sql: [
          'SELECT *',
          `FROM ${documentsTable}`,
          'WHERE id = ?',
          'LIMIT 1',
        ].join(' '),
        params: [id],
      });
      return sqliteLocalVectorDocumentFromRow(rows[0]);
    },
    async upsertDocument(
      document: CodexProviderRelayLocalVectorIndexDocument,
      chunks: CodexProviderRelayLocalVectorIndexChunk[],
    ): Promise<void> {
      await ensureInitialized();
      await sqliteLocalVectorRun(query, {
        sql: [
          `INSERT INTO ${documentsTable}`,
          [
            '(id, source_name, root, path, uri, title, filename, size, mtime_ms, content_hash, embedding_model,',
            'index_version, chunker_version, chunking_config_hash, embedding_dimensions,',
            'content_hash_algorithm, stat_fingerprint, updated_at)',
          ].join(' '),
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          'ON CONFLICT(id) DO UPDATE SET',
          'source_name = excluded.source_name,',
          'root = excluded.root,',
          'path = excluded.path,',
          'uri = excluded.uri,',
          'title = excluded.title,',
          'filename = excluded.filename,',
          'size = excluded.size,',
          'mtime_ms = excluded.mtime_ms,',
          'content_hash = excluded.content_hash,',
          'embedding_model = excluded.embedding_model,',
          'index_version = excluded.index_version,',
          'chunker_version = excluded.chunker_version,',
          'chunking_config_hash = excluded.chunking_config_hash,',
          'embedding_dimensions = excluded.embedding_dimensions,',
          'content_hash_algorithm = excluded.content_hash_algorithm,',
          'stat_fingerprint = excluded.stat_fingerprint,',
          'updated_at = excluded.updated_at',
        ].join(' '),
        params: [
          document.id,
          document.sourceName,
          document.root,
          document.path,
          document.uri,
          document.title,
          document.filename,
          document.size,
          document.mtimeMs,
          document.contentHash,
          document.embeddingModel,
          document.indexVersion ?? null,
          document.chunkerVersion ?? null,
          document.chunkingConfigHash ?? null,
          document.embeddingDimensions ?? null,
          document.contentHashAlgorithm ?? null,
          document.statFingerprint ?? null,
          document.updatedAt,
        ],
      });
      await sqliteLocalVectorRun(query, {
        sql: `DELETE FROM ${chunksTable} WHERE document_id = ?`,
        params: [document.id],
      });
      for (const chunk of chunks) {
        await sqliteLocalVectorRun(query, {
          sql: [
            `INSERT INTO ${chunksTable}`,
            '(id, document_id, source_name, root, path, uri, title, filename, text, chunk_index, start_line, end_line, embedding_json, metadata_json)',
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            'ON CONFLICT(id) DO UPDATE SET',
            'document_id = excluded.document_id,',
            'source_name = excluded.source_name,',
            'root = excluded.root,',
            'path = excluded.path,',
            'uri = excluded.uri,',
            'title = excluded.title,',
            'filename = excluded.filename,',
            'text = excluded.text,',
            'chunk_index = excluded.chunk_index,',
            'start_line = excluded.start_line,',
            'end_line = excluded.end_line,',
            'embedding_json = excluded.embedding_json,',
            'metadata_json = excluded.metadata_json',
          ].join(' '),
          params: [
            chunk.id,
            chunk.documentId,
            chunk.sourceName,
            chunk.root,
            chunk.path,
            chunk.uri,
            chunk.title,
            chunk.filename,
            chunk.text,
            chunk.chunkIndex,
            chunk.startLine,
            chunk.endLine,
            JSON.stringify(chunk.embedding),
            JSON.stringify(normalizeFileSearchAttributes(chunk.metadata)),
          ],
        });
      }
    },
    async listChunks(sourceName: string): Promise<CodexProviderRelayLocalVectorIndexChunk[]> {
      await ensureInitialized();
      const rows = await sqliteLocalVectorAll(query, {
        sql: [
          'SELECT *',
          `FROM ${chunksTable}`,
          'WHERE source_name = ?',
          'ORDER BY path ASC, chunk_index ASC',
        ].join(' '),
        params: [sourceName],
      });
      return rows.map(sqliteLocalVectorChunkFromRow).filter(Boolean) as CodexProviderRelayLocalVectorIndexChunk[];
    },
    async listDocuments(sourceName: string): Promise<CodexProviderRelayLocalVectorIndexDocument[]> {
      await ensureInitialized();
      const rows = await sqliteLocalVectorAll(query, {
        sql: [
          'SELECT *',
          `FROM ${documentsTable}`,
          'WHERE source_name = ?',
          'ORDER BY path ASC',
        ].join(' '),
        params: [sourceName],
      });
      return rows.map(sqliteLocalVectorDocumentFromRow).filter(Boolean) as CodexProviderRelayLocalVectorIndexDocument[];
    },
    async deleteDocuments(ids: string[]): Promise<void> {
      await ensureInitialized();
      for (const id of ids.map(normalizeString).filter(Boolean)) {
        await sqliteLocalVectorRun(query, {
          sql: `DELETE FROM ${chunksTable} WHERE document_id = ?`,
          params: [id],
        });
        await sqliteLocalVectorRun(query, {
          sql: `DELETE FROM ${documentsTable} WHERE id = ?`,
          params: [id],
        });
      }
    },
    async deleteStaleDocuments(sourceName: string, liveDocumentIds: string[]): Promise<string[]> {
      await ensureInitialized();
      const liveIds = new Set(liveDocumentIds.map(normalizeString).filter(Boolean));
      const rows = await sqliteLocalVectorAll(query, {
        sql: [
          'SELECT *',
          `FROM ${documentsTable}`,
          'WHERE source_name = ?',
          'ORDER BY path ASC',
        ].join(' '),
        params: [sourceName],
      });
      const documents = rows.map(sqliteLocalVectorDocumentFromRow).filter(Boolean) as CodexProviderRelayLocalVectorIndexDocument[];
      const staleIds = documents
        .map((document) => document.id)
        .filter((id) => !liveIds.has(id));
      if (staleIds.length > 0) {
        for (const id of staleIds) {
          await sqliteLocalVectorRun(query, {
            sql: `DELETE FROM ${chunksTable} WHERE document_id = ?`,
            params: [id],
          });
          await sqliteLocalVectorRun(query, {
            sql: `DELETE FROM ${documentsTable} WHERE id = ?`,
            params: [id],
          });
        }
      }
      return staleIds;
    },
  };
}

function normalizeSqliteLocalVectorIndexStoreQuery(
  options: CodexProviderRelaySqliteLocalVectorIndexStoreOptions,
): CodexProviderRelaySqliteLocalVectorIndexStoreQueryFunction {
  if (typeof options.query === 'function') {
    return options.query;
  }
  if (
    options.database
    && typeof options.database.all === 'function'
    && typeof options.database.run === 'function'
  ) {
    return (request) => request.operation === 'all'
      ? options.database!.all(request.sql, request.params)
      : options.database!.run(request.sql, request.params);
  }
  throw new Error('sqlite local-vector index store requires a query function or database.all/database.run.');
}

async function initializeSqliteLocalVectorIndexStore({
  query,
  documentsTable,
  chunksTable,
  chunksSourceIndex,
  chunksDocumentIndex,
}: {
  query: CodexProviderRelaySqliteLocalVectorIndexStoreQueryFunction;
  documentsTable: string;
  chunksTable: string;
  chunksSourceIndex: string;
  chunksDocumentIndex: string;
}): Promise<void> {
  await sqliteLocalVectorRun(query, {
    sql: [
      `CREATE TABLE IF NOT EXISTS ${documentsTable} (`,
      'id TEXT PRIMARY KEY,',
      'source_name TEXT NOT NULL,',
      'root TEXT NOT NULL,',
      'path TEXT NOT NULL,',
      'uri TEXT NOT NULL,',
      'title TEXT NOT NULL,',
      'filename TEXT NOT NULL,',
      'size INTEGER NOT NULL,',
      'mtime_ms REAL NOT NULL,',
      'content_hash TEXT NOT NULL,',
      'embedding_model TEXT NOT NULL,',
      'index_version TEXT,',
      'chunker_version TEXT,',
      'chunking_config_hash TEXT,',
      'embedding_dimensions INTEGER,',
      'content_hash_algorithm TEXT,',
      'stat_fingerprint TEXT,',
      'updated_at TEXT NOT NULL',
      ')',
    ].join(' '),
    params: [],
  });
  await addSqliteLocalVectorDocumentColumnIfMissing(query, documentsTable, 'index_version TEXT');
  await addSqliteLocalVectorDocumentColumnIfMissing(query, documentsTable, 'chunker_version TEXT');
  await addSqliteLocalVectorDocumentColumnIfMissing(query, documentsTable, 'chunking_config_hash TEXT');
  await addSqliteLocalVectorDocumentColumnIfMissing(query, documentsTable, 'embedding_dimensions INTEGER');
  await addSqliteLocalVectorDocumentColumnIfMissing(query, documentsTable, 'content_hash_algorithm TEXT');
  await addSqliteLocalVectorDocumentColumnIfMissing(query, documentsTable, 'stat_fingerprint TEXT');
  await sqliteLocalVectorRun(query, {
    sql: [
      `CREATE TABLE IF NOT EXISTS ${chunksTable} (`,
      'id TEXT PRIMARY KEY,',
      'document_id TEXT NOT NULL,',
      'source_name TEXT NOT NULL,',
      'root TEXT NOT NULL,',
      'path TEXT NOT NULL,',
      'uri TEXT NOT NULL,',
      'title TEXT NOT NULL,',
      'filename TEXT NOT NULL,',
      'text TEXT NOT NULL,',
      'chunk_index INTEGER NOT NULL,',
      'start_line INTEGER NOT NULL,',
      'end_line INTEGER NOT NULL,',
      'embedding_json TEXT NOT NULL,',
      'metadata_json TEXT,',
      `FOREIGN KEY(document_id) REFERENCES ${documentsTable}(id) ON DELETE CASCADE`,
      ')',
    ].join(' '),
    params: [],
  });
  await sqliteLocalVectorRun(query, {
    sql: `CREATE INDEX IF NOT EXISTS ${chunksSourceIndex} ON ${chunksTable} (source_name, path, chunk_index)`,
    params: [],
  });
  await sqliteLocalVectorRun(query, {
    sql: `CREATE INDEX IF NOT EXISTS ${chunksDocumentIndex} ON ${chunksTable} (document_id)`,
    params: [],
  });
}

async function addSqliteLocalVectorDocumentColumnIfMissing(
  query: CodexProviderRelaySqliteLocalVectorIndexStoreQueryFunction,
  documentsTable: string,
  columnDefinition: string,
): Promise<void> {
  await sqliteLocalVectorRun(query, {
    sql: `ALTER TABLE ${documentsTable} ADD COLUMN ${columnDefinition}`,
    params: [],
  }).catch((error) => {
    if (error instanceof Error && /duplicate column|already exists/u.test(error.message.toLowerCase())) {
      return;
    }
    throw error;
  });
}

async function sqliteLocalVectorAll(
  query: CodexProviderRelaySqliteLocalVectorIndexStoreQueryFunction,
  request: Omit<CodexProviderRelaySqliteLocalVectorIndexStoreQueryRequest, 'operation'>,
): Promise<JsonRecord[]> {
  const result = await query({
    operation: 'all',
    sql: request.sql,
    params: request.params,
  });
  return Array.isArray(result)
    ? result.filter((row): row is JsonRecord => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    : [];
}

async function sqliteLocalVectorRun(
  query: CodexProviderRelaySqliteLocalVectorIndexStoreQueryFunction,
  request: Omit<CodexProviderRelaySqliteLocalVectorIndexStoreQueryRequest, 'operation'>,
): Promise<void> {
  await query({
    operation: 'run',
    sql: request.sql,
    params: request.params,
  });
}

function sqliteLocalVectorDocumentFromRow(
  row: JsonRecord | undefined,
): CodexProviderRelayLocalVectorIndexDocument | null {
  if (!row) {
    return null;
  }
  const id = normalizeString(row.id);
  if (!id) {
    return null;
  }
  return {
    id,
    sourceName: normalizeString(row.source_name),
    root: normalizeString(row.root),
    path: normalizeString(row.path),
    uri: normalizeString(row.uri),
    title: normalizeString(row.title),
    filename: normalizeString(row.filename),
    size: normalizeNonNegativeInteger(row.size),
    mtimeMs: Number.isFinite(Number(row.mtime_ms)) ? Number(row.mtime_ms) : 0,
    contentHash: normalizeString(row.content_hash),
    embeddingModel: normalizeString(row.embedding_model),
    indexVersion: normalizeString(row.index_version) || null,
    chunkerVersion: normalizeString(row.chunker_version) || null,
    chunkingConfigHash: normalizeString(row.chunking_config_hash) || null,
    embeddingDimensions: normalizeNonNegativeInteger(row.embedding_dimensions) || null,
    contentHashAlgorithm: normalizeString(row.content_hash_algorithm) || null,
    statFingerprint: normalizeString(row.stat_fingerprint) || null,
    updatedAt: normalizeString(row.updated_at),
  };
}

function sqliteLocalVectorChunkFromRow(
  row: JsonRecord | undefined,
): CodexProviderRelayLocalVectorIndexChunk | null {
  if (!row) {
    return null;
  }
  const id = normalizeString(row.id);
  const documentId = normalizeString(row.document_id);
  const text = normalizeString(row.text);
  if (!id || !documentId || !text) {
    return null;
  }
  const metadata = parseJsonRecordOrNull(row.metadata_json);
  return {
    id,
    documentId,
    sourceName: normalizeString(row.source_name),
    root: normalizeString(row.root),
    path: normalizeString(row.path),
    uri: normalizeString(row.uri),
    title: normalizeString(row.title),
    filename: normalizeString(row.filename),
    text,
    chunkIndex: normalizeNonNegativeInteger(row.chunk_index),
    startLine: normalizeNonNegativeInteger(row.start_line) || 1,
    endLine: normalizeNonNegativeInteger(row.end_line) || 1,
    embedding: normalizeEmbeddingVector(parseJsonArrayOrEmpty(row.embedding_json)),
    metadata,
  };
}
