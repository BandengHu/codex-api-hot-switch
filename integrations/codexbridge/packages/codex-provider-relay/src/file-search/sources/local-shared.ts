import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CandidateFile,
  CodexProviderRelayFileSearchSourceMatch,
  CodexProviderRelayLocalFileSearchSourceOptions,
  JsonRecord,
  LocalFileSearchRoot,
  NormalizedLocalFileSearchOptions,
} from '../types.js';
import {
  DEFAULT_IGNORE_DIRECTORIES,
  DEFAULT_IGNORE_EXTENSIONS,
  clampInteger,
  contentChunksForTerms,
  firstNonEmptyString,
  isPathInsideRoot,
  isSafeSymlinkTarget,
  lexicalScoreForText,
  normalizeFileSearchAttributes,
  normalizeRelativePath,
  normalizeString,
  pathMatchesGlob,
  stableFileSearchFileId,
} from '../shared.js';

export async function normalizeLocalFileSearchOptions(
  options: CodexProviderRelayLocalFileSearchSourceOptions,
): Promise<NormalizedLocalFileSearchOptions> {
  const roots = Array.isArray(options.roots)
    ? options.roots.map((root) => path.resolve(root)).filter(Boolean)
    : [];
  if (roots.length === 0) {
    throw new Error('file_search local-fs source requires at least one explicit root.');
  }
  const normalizedRoots: LocalFileSearchRoot[] = [];
  for (const root of [...new Set(roots)]) {
    const realPath = await fs.realpath(root).catch(() => root);
    normalizedRoots.push({
      path: root,
      realPath,
    });
  }
  return {
    name: normalizeString(options.name) || 'local-fs',
    type: 'local-fs',
    roots: normalizedRoots,
    maxFilesScanned: clampInteger(options.maxFilesScanned, 1, 20_000, 2_000),
    maxBytesPerFile: clampInteger(options.maxBytesPerFile, 1_024, 2 * 1024 * 1024, 256 * 1024),
    snippetLines: clampInteger(options.snippetLines, 1, 8, 2),
    includeContent: options.includeContent !== false,
    followSymlinks: Boolean(options.followSymlinks),
    ignoreDirectories: new Set([
      ...DEFAULT_IGNORE_DIRECTORIES,
      ...(Array.isArray(options.ignoreDirectories) ? options.ignoreDirectories : []),
    ].map((entry) => entry.toLowerCase())),
    ignoreExtensions: new Set([
      ...DEFAULT_IGNORE_EXTENSIONS,
      ...(Array.isArray(options.ignoreExtensions) ? options.ignoreExtensions : []),
    ].map((entry) => entry.toLowerCase())),
  };
}

export function assertExplicitLocalFileSearchRoots(value: unknown): void {
  if (!Array.isArray(value) || value.map((root) => normalizeString(root)).filter(Boolean).length === 0) {
    throw new Error('file_search local-fs source requires at least one explicit root.');
  }
}

export async function collectCandidateFiles(
  options: NormalizedLocalFileSearchOptions,
  pathGlob: string,
): Promise<CandidateFile[]> {
  const candidates: CandidateFile[] = [];
  for (const root of options.roots) {
    await walkDirectory({
      options,
      root,
      directory: root.path,
      pathGlob,
      candidates,
    });
  }
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return candidates;
}

async function walkDirectory({
  options,
  root,
  directory,
  pathGlob,
  candidates,
}: {
  options: NormalizedLocalFileSearchOptions;
  root: LocalFileSearchRoot;
  directory: string;
  pathGlob: string;
  candidates: CandidateFile[];
}): Promise<void> {
  if (candidates.length >= options.maxFilesScanned) {
    return;
  }
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (candidates.length >= options.maxFilesScanned) {
      return;
    }
    const entryPath = path.join(directory, entry.name);
    const relativePath = normalizeRelativePath(path.relative(root.path, entryPath));
    if (!isPathInsideRoot(root.path, entryPath)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (options.ignoreDirectories.has(entry.name.toLowerCase())) {
        continue;
      }
      await walkDirectory({
        options,
        root,
        directory: entryPath,
        pathGlob,
        candidates,
      });
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (!options.followSymlinks || !await isSafeSymlinkTarget(root, entryPath)) {
        continue;
      }
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    if (options.ignoreExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    if (pathGlob && !pathMatchesGlob(relativePath, pathGlob)) {
      continue;
    }
    candidates.push({
      root,
      absolutePath: entryPath,
      relativePath,
    });
  }
}

export function searchFileContent({
  candidate,
  content,
  terms,
  includeContent,
  snippetLines,
  sourceName,
}: {
  candidate: CandidateFile;
  content: string;
  terms: string[];
  includeContent: boolean;
  snippetLines: number;
  sourceName: string;
}): CodexProviderRelayFileSearchSourceMatch | null {
  return searchTextContent({
    title: candidate.relativePath,
    uri: pathToFileURL(candidate.absolutePath).toString(),
    path: candidate.relativePath,
    root: candidate.root.path,
    sourceName,
    sourceType: 'local-fs',
    attributes: {
      root: candidate.root.path,
      path: candidate.relativePath,
      filename: path.basename(candidate.relativePath),
    },
    content,
    terms,
    includeContent,
    snippetLines,
  });
}

export function searchTextContent({
  title,
  uri,
  path: resultPath,
  root,
  sourceName,
  sourceType,
  attributes,
  content,
  terms,
  includeContent,
  snippetLines,
}: {
  title: string;
  uri: string;
  path: string;
  root: string | null;
  sourceName: string;
  sourceType: string;
  attributes?: JsonRecord | null;
  content: string;
  terms: string[];
  includeContent: boolean;
  snippetLines: number;
}): CodexProviderRelayFileSearchSourceMatch | null {
  const score = lexicalScoreForText({
    title,
    path: resultPath,
    content,
    terms,
  });
  if (score <= 0) {
    return null;
  }
  const filename = path.basename(resultPath) || title;
  const fileId = stableFileSearchFileId(sourceName, resultPath || title);
  const normalizedAttributes = normalizeFileSearchAttributes({
    ...(attributes && typeof attributes === 'object' ? attributes : {}),
    filename,
    path: resultPath,
    source: sourceName,
    source_type: sourceType,
    ...(root ? { root } : {}),
  });
  return {
    file_id: fileId,
    filename,
    title,
    uri,
    path: resultPath,
    root,
    source: sourceName,
    sourceType,
    score,
    attributes: normalizedAttributes,
    content: includeContent
      ? contentChunksForTerms({
        content,
        terms,
        snippetLines,
      })
      : [],
  };
}
