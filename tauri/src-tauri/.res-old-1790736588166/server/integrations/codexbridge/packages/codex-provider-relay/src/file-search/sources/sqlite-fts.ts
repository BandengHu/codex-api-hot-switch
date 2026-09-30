import path from 'node:path';
import type {
  CodexProviderRelayFileSearchSource,
  CodexProviderRelayFileSearchSourceMatch,
  CodexProviderRelayFileSearchSourceRequest,
  CodexProviderRelayFileSearchSourceResult,
  CodexProviderRelaySqliteFtsFileSearchSourceOptions,
  CodexProviderRelaySqliteFtsQueryFunction,
  JsonRecord,
  NormalizedMemoryFileSearchDocument,
  NormalizedSqliteFtsFileSearchOptions,
} from '../types.js';
import {
  clampInteger,
  firstNonEmptyString,
  normalizeRelativePath,
  normalizeSqlIdentifier,
  normalizeString,
  pathMatchesGlob,
  sqlAliasFromIdentifier,
  sqliteFtsQueryFromTerms,
} from '../shared.js';
import { searchTextContent } from './local-shared.js';

export function createCodexProviderRelaySqliteFtsFileSearchSource(
  options: CodexProviderRelaySqliteFtsFileSearchSourceOptions,
): CodexProviderRelayFileSearchSource {
  const normalizedOptions = normalizeSqliteFtsFileSearchOptions(options);
  return {
    name: normalizedOptions.name,
    type: 'sqlite-fts',
    async search(request: CodexProviderRelayFileSearchSourceRequest): Promise<CodexProviderRelayFileSearchSourceResult> {
      const maxResults = request.maxResults;
      const includeContent = typeof request.includeContent === 'boolean'
        ? request.includeContent
        : normalizedOptions.includeContent;
      const maxBytesPerDocument = Math.min(request.maxBytesPerFile, normalizedOptions.maxBytesPerDocument);
      const snippetLines = Math.min(request.snippetLines, normalizedOptions.snippetLines);
      const ftsQuery = sqliteFtsQueryFromTerms(request.terms);
      if (!ftsQuery) {
        return {
          results: [],
          scannedFiles: 0,
          skippedFiles: 0,
        };
      }
      const querySpec = buildSqliteFtsQuery({
        options: normalizedOptions,
        ftsQuery,
        pathGlob: request.pathGlob,
        maxResults: Math.min(maxResults, normalizedOptions.maxRows),
      });

      await request.emitDelta?.('querying sqlite fts', {
        source: normalizedOptions.name,
        table: normalizedOptions.table,
        maxResults,
      });

      const rows = await normalizedOptions.query({
        sql: querySpec.sql,
        params: querySpec.params,
        query: request.query,
        ftsQuery,
        pathGlob: request.pathGlob,
        maxResults,
        terms: request.terms,
      });

      const results: CodexProviderRelayFileSearchSourceMatch[] = [];
      let scannedRows = 0;
      let skippedRows = 0;
      for (const row of Array.isArray(rows) ? rows : []) {
        if (scannedRows >= normalizedOptions.maxRows || results.length >= maxResults) {
          break;
        }
        const document = sqliteFtsRowToMemoryDocument(row, normalizedOptions);
        if (!document) {
          skippedRows += 1;
          continue;
        }
        if (request.pathGlob && !pathMatchesGlob(document.path, request.pathGlob)) {
          continue;
        }
        const documentBytes = Buffer.byteLength(document.content, 'utf8');
        if (documentBytes > maxBytesPerDocument) {
          skippedRows += 1;
          continue;
        }
        scannedRows += 1;
        const result = searchTextContent({
          title: document.title,
          uri: document.uri,
          path: document.path,
          root: null,
          sourceName: normalizedOptions.name,
          sourceType: 'sqlite-fts',
          attributes: document.metadata,
          content: document.content,
          terms: request.terms,
          includeContent,
          snippetLines,
        });
        if (result) {
          result.score += sqliteFtsScoreFromRow(row, normalizedOptions);
          results.push(result);
          await request.emitDelta?.('sqlite fts row matched', {
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
        scannedFiles: scannedRows,
        skippedFiles: skippedRows,
        metadata: {
          provider: 'sqlite-fts',
          source: normalizedOptions.name,
          table: normalizedOptions.table,
          scannedRows,
          skippedRows,
        },
      };
    },
  };
}

function normalizeSqliteFtsFileSearchOptions(
  options: CodexProviderRelaySqliteFtsFileSearchSourceOptions,
): NormalizedSqliteFtsFileSearchOptions {
  const table = normalizeSqlIdentifier(options.table, 'sqlite-fts table');
  const query = normalizeSqliteFtsQuery(options);
  const columns = {
    id: normalizeSqlIdentifier(options.columns?.id || 'id', 'sqlite-fts id column'),
    title: normalizeSqlIdentifier(options.columns?.title || 'title', 'sqlite-fts title column'),
    uri: normalizeSqlIdentifier(options.columns?.uri || 'uri', 'sqlite-fts uri column'),
    path: normalizeSqlIdentifier(options.columns?.path || 'path', 'sqlite-fts path column'),
    content: normalizeSqlIdentifier(options.columns?.content || 'content', 'sqlite-fts content column'),
    score: normalizeSqlIdentifier(options.columns?.score || 'score', 'sqlite-fts score column'),
  };
  return {
    name: normalizeString(options.name) || 'sqlite-fts',
    type: 'sqlite-fts',
    table,
    tableMatchTarget: table,
    query,
    columns,
    metadataColumns: Array.isArray(options.metadataColumns)
      ? options.metadataColumns.map((column) => normalizeSqlIdentifier(column, 'sqlite-fts metadata column'))
      : [],
    maxRows: clampInteger(options.maxRows, 1, 1_000, 50),
    maxBytesPerDocument: clampInteger(options.maxBytesPerDocument, 1_024, 2 * 1024 * 1024, 256 * 1024),
    snippetLines: clampInteger(options.snippetLines, 1, 8, 2),
    includeContent: options.includeContent !== false,
  };
}

function normalizeSqliteFtsQuery(
  options: CodexProviderRelaySqliteFtsFileSearchSourceOptions,
): CodexProviderRelaySqliteFtsQueryFunction {
  if (typeof options.query === 'function') {
    return options.query;
  }
  if (options.database && typeof options.database.all === 'function') {
    return ({ sql, params }) => options.database!.all(sql, params);
  }
  throw new Error('sqlite-fts file_search source requires a query function or database.all.');
}

function buildSqliteFtsQuery({
  options,
  ftsQuery,
  pathGlob,
  maxResults,
}: {
  options: NormalizedSqliteFtsFileSearchOptions;
  ftsQuery: string;
  pathGlob: string;
  maxResults: number;
}): { sql: string; params: unknown[] } {
  const params: unknown[] = [ftsQuery];
  const selectedColumns = [
    `${options.columns.id} AS id`,
    `${options.columns.title} AS title`,
    `${options.columns.uri} AS uri`,
    `${options.columns.path} AS path`,
    `${options.columns.content} AS content`,
    `-bm25(${options.tableMatchTarget}) AS score`,
    ...options.metadataColumns.map((column) => `${column} AS ${sqlAliasFromIdentifier(column)}`),
  ];
  const where = [`${options.tableMatchTarget} MATCH ?`];
  if (pathGlob) {
    where.push(`${options.columns.path} GLOB ?`);
    params.push(pathGlob);
  }
  params.push(maxResults);
  return {
    sql: [
      `SELECT ${selectedColumns.join(', ')}`,
      `FROM ${options.table}`,
      `WHERE ${where.join(' AND ')}`,
      'ORDER BY score DESC',
      'LIMIT ?',
    ].join(' '),
    params,
  };
}

function sqliteFtsRowToMemoryDocument(
  row: JsonRecord,
  options: NormalizedSqliteFtsFileSearchOptions,
): NormalizedMemoryFileSearchDocument | null {
  if (!row || typeof row !== 'object') {
    return null;
  }
  const id = firstNonEmptyString([row.id, row.path, row.title]);
  const content = normalizeString(row.content);
  if (!id || !content) {
    return null;
  }
  const rawPath = normalizeRelativePath(firstNonEmptyString([row.path, row.title, id]));
  const safePath = rawPath && !path.isAbsolute(rawPath) && !rawPath.split('/').includes('..')
    ? rawPath
    : `sqlite/${id}`;
  const metadata: JsonRecord = {};
  for (const column of options.metadataColumns) {
    const alias = sqlAliasFromIdentifier(column);
    if (row[alias] !== undefined) {
      metadata[alias] = row[alias];
    }
  }
  return {
    id,
    title: firstNonEmptyString([row.title, safePath, id]),
    uri: normalizeString(row.uri) || `sqlite://${encodeURIComponent(id)}`,
    path: safePath,
    content,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
  };
}

function sqliteFtsScoreFromRow(
  row: JsonRecord,
  options: NormalizedSqliteFtsFileSearchOptions,
): number {
  const score = Number(row.score ?? row[sqlAliasFromIdentifier(options.columns.score)]);
  if (!Number.isFinite(score)) {
    return 0;
  }
  return score;
}
