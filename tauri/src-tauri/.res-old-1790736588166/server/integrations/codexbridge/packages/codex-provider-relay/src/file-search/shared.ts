import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CodexProviderRelayFileSearchChunk,
  CodexProviderRelayFileSearchSourceMatch,
  JsonRecord,
  LocalFileSearchRoot,
  NormalizedMemoryFileSearchDocument,
} from './types.js';

export const DEFAULT_IGNORE_DIRECTORIES = [
  '.git',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'build',
  'node_modules',
];

export const DEFAULT_IGNORE_EXTENSIONS = [
  '.7z',
  '.avi',
  '.bin',
  '.bmp',
  '.class',
  '.dll',
  '.dmg',
  '.exe',
  '.gif',
  '.gz',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.lock',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.so',
  '.tar',
  '.webp',
  '.zip',
];


export function normalizeHeaders(value: Record<string, string> | null | undefined): Record<string, string> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(Object.entries(value)
    .map(([key, headerValue]) => [normalizeString(key), normalizeString(headerValue)] as const)
    .filter(([key, headerValue]) => key && headerValue));
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeEmbeddingVector(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));
}

export function parseJsonRecord(text: string, label: string): JsonRecord {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object.`);
    }
    return parsed as JsonRecord;
  } catch (error) {
    if (error instanceof Error && error.message.includes(label)) {
      throw error;
    }
    throw new Error(`${label} was not valid JSON: ${text.slice(0, 500)}`);
  }
}

export function parseJsonArrayOrEmpty(value: unknown): unknown[] {
  const text = normalizeString(value);
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseJsonRecordOrNull(value: unknown): JsonRecord | null {
  const text = normalizeString(value);
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : null;
  } catch {
    return null;
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const dimensions = Math.min(left.length, right.length);
  if (dimensions === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm <= 0 || rightNorm <= 0) {
    return 0;
  }
  return Math.max(0, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

export function lexicalScoreForText({
  title,
  path: resultPath,
  content,
  terms,
}: {
  title: string;
  path: string;
  content: string;
  terms: string[];
}): number {
  let score = 0;
  const lowerPath = resultPath.toLowerCase();
  const lowerTitle = title.toLowerCase();
  const lowerContent = content.toLowerCase();
  for (const term of terms) {
    if (lowerPath.includes(term)) {
      score += 2;
    }
    if (lowerTitle.includes(term)) {
      score += 4;
    }
    const matches = lowerContent.match(new RegExp(escapeRegExp(term), 'gu'));
    score += (matches?.length ?? 0) * 10;
  }
  return score;
}

export function createFileSearchSourceMatchFromDocument({
  document,
  sourceName,
  sourceType,
  score,
  includeContent,
  snippetLines,
  terms,
  attributes,
}: {
  document: NormalizedMemoryFileSearchDocument;
  sourceName: string;
  sourceType: string;
  score: number;
  includeContent: boolean;
  snippetLines: number;
  terms: string[];
  attributes?: JsonRecord | null;
}): CodexProviderRelayFileSearchSourceMatch | null {
  if (score <= 0) {
    return null;
  }
  const filename = path.basename(document.path) || document.title;
  const contentChunks = includeContent
    ? contentChunksForTerms({
      content: document.content,
      terms,
      snippetLines,
    })
    : [];
  return {
    file_id: stableFileSearchFileId(sourceName, document.path || document.title),
    filename,
    title: document.title,
    uri: document.uri,
    path: document.path,
    root: null,
    source: sourceName,
    sourceType,
    score,
    attributes: normalizeFileSearchAttributes({
      ...(attributes && typeof attributes === 'object' ? attributes : {}),
      filename,
      path: document.path,
      source: sourceName,
      source_type: sourceType,
    }),
    content: contentChunks,
  };
}

export function contentChunksForTerms({
  content,
  terms,
  snippetLines,
}: {
  content: string;
  terms: string[];
  snippetLines: number;
}): CodexProviderRelayFileSearchChunk[] {
  const lines = content.split(/\r?\n/u);
  const chunks: CodexProviderRelayFileSearchChunk[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lowerLine = lines[index].toLowerCase();
    const hits = terms.filter((term) => lowerLine.includes(term)).length;
    if (hits === 0) {
      continue;
    }
    for (
      let snippetIndex = Math.max(0, index - snippetLines);
      snippetIndex <= Math.min(lines.length - 1, index + snippetLines);
      snippetIndex += 1
    ) {
      if (chunks.some((chunk) => chunk.line === snippetIndex + 1)) {
        continue;
      }
      chunks.push({
        type: 'text',
        line: snippetIndex + 1,
        text: lines[snippetIndex].slice(0, 500),
        start_line: snippetIndex + 1,
        end_line: snippetIndex + 1,
      });
      if (chunks.length >= 4) {
        return chunks;
      }
    }
  }
  if (chunks.length === 0 && content) {
    chunks.push({
      type: 'text',
      line: 1,
      text: content.split(/\r?\n/u)[0]?.slice(0, 500) ?? '',
      start_line: 1,
      end_line: 1,
    });
  }
  return chunks.filter((chunk) => chunk.text);
}

export function sqliteFtsQueryFromTerms(terms: string[]): string {
  return terms
    .map((term) => `"${term.replace(/"/gu, '""')}"`)
    .join(' OR ');
}

export function normalizeSqlIdentifier(value: unknown, label: string): string {
  const raw = normalizeString(value);
  if (!raw) {
    throw new Error(`${label} is required.`);
  }
  const parts = raw.split('.');
  if (parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(part))) {
    throw new Error(`${label} must be a safe SQL identifier.`);
  }
  return parts.map((part) => `"${part}"`).join('.');
}

export function normalizeSqliteTablePrefix(value: unknown, fallback: string): string {
  const raw = normalizeString(value) || fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(raw)) {
    throw new Error('sqlite local-vector tablePrefix must be a safe SQL identifier prefix.');
  }
  return raw;
}

export function sqlAliasFromIdentifier(identifier: string): string {
  return identifier
    .split('.')
    .at(-1)!
    .replace(/^"|"$/gu, '');
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function looksBinary(content: string): boolean {
  return content.includes('\0');
}

export function pathMatchesGlob(relativePath: string, glob: string): boolean {
  const normalizedGlob = normalizeRelativePath(glob);
  if (!normalizedGlob || normalizedGlob === '*') {
    return true;
  }
  if (!normalizedGlob.includes('*')) {
    return relativePath.includes(normalizedGlob);
  }
  const escaped = normalizedGlob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'u').test(relativePath);
}

export async function isSafeSymlinkTarget(root: LocalFileSearchRoot, candidate: string): Promise<boolean> {
  const realPath = await fs.realpath(candidate).catch(() => '');
  return Boolean(realPath && isPathInsideRoot(root.realPath, realPath));
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function normalizePathGlob(value: unknown): string {
  const normalized = normalizeRelativePath(normalizeString(value));
  if (!normalized) {
    return '';
  }
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('file_search path_glob must stay inside configured roots.');
  }
  return normalized;
}

export function tokenizeQuery(query: string): string[] {
  return [...new Set(query
    .toLowerCase()
    .split(/[^a-z0-9_\-\u4e00-\u9fff]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2))];
}

export function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, '/');
}

export function firstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

export function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(normalizeString).filter(Boolean))];
}

export function normalizeFileSearchAttributes(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const attributes: JsonRecord = {};
  for (const [key, entryValue] of Object.entries(value as JsonRecord)) {
    const normalizedKey = normalizeString(key);
    if (!normalizedKey || entryValue === undefined) {
      continue;
    }
    if (
      entryValue === null
      || typeof entryValue === 'string'
      || typeof entryValue === 'number'
      || typeof entryValue === 'boolean'
      || Array.isArray(entryValue)
    ) {
      attributes[normalizedKey] = entryValue;
    }
  }
  return attributes;
}

export function stableFileSearchFileId(sourceName: string, resultPath: string): string {
  const raw = `${sourceName}:${resultPath}`;
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `file_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function stableContentHash(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}:${bytes.byteLength}`;
}


export function normalizeNonNegativeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return 0;
  }
  return Math.floor(number);
}

export function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
