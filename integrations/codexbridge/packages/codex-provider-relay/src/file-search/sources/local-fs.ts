import fs from 'node:fs/promises';
import type {
  CodexProviderRelayFileSearchSource,
  CodexProviderRelayFileSearchSourceMatch,
  CodexProviderRelayFileSearchSourceRequest,
  CodexProviderRelayFileSearchSourceResult,
  CodexProviderRelayLocalFileSearchSourceOptions,
} from '../types.js';
import {
  looksBinary,
  normalizeString,
} from '../shared.js';
import {
  assertExplicitLocalFileSearchRoots,
  collectCandidateFiles,
  normalizeLocalFileSearchOptions,
  searchFileContent,
} from './local-shared.js';

export function createCodexProviderRelayLocalFileSearchSource(
  options: CodexProviderRelayLocalFileSearchSourceOptions,
): CodexProviderRelayFileSearchSource {
  assertExplicitLocalFileSearchRoots(options.roots);
  const normalizedOptionsPromise = normalizeLocalFileSearchOptions(options);
  const sourceName = normalizeString(options.name) || 'local-fs';
  return {
    name: sourceName,
    type: 'local-fs',
    async search(request: CodexProviderRelayFileSearchSourceRequest): Promise<CodexProviderRelayFileSearchSourceResult> {
      const normalizedOptions = await normalizedOptionsPromise;
      const maxResults = request.maxResults;
      const includeContent = typeof request.includeContent === 'boolean'
        ? request.includeContent
        : normalizedOptions.includeContent;
      const maxBytesPerFile = Math.min(request.maxBytesPerFile, normalizedOptions.maxBytesPerFile);
      const snippetLines = Math.min(request.snippetLines, normalizedOptions.snippetLines);

      await request.emitDelta?.('scanning roots', {
        source: normalizedOptions.name,
        roots: normalizedOptions.roots.map((root) => root.path),
        maxResults,
      });
      const candidates = await collectCandidateFiles(normalizedOptions, request.pathGlob);
      await request.emitDelta?.('candidate files collected', {
        source: normalizedOptions.name,
        count: candidates.length,
      });

      const results: CodexProviderRelayFileSearchSourceMatch[] = [];
      let scannedFiles = 0;
      let skippedFiles = 0;
      for (const candidate of candidates) {
        if (scannedFiles >= normalizedOptions.maxFilesScanned || results.length >= maxResults) {
          break;
        }
        const stat = await fs.stat(candidate.absolutePath).catch(() => null);
        if (!stat || !stat.isFile() || stat.size > maxBytesPerFile) {
          skippedFiles += 1;
          continue;
        }
        const content = await fs.readFile(candidate.absolutePath, 'utf8').catch(() => null);
        scannedFiles += 1;
        if (!content || looksBinary(content)) {
          skippedFiles += 1;
          continue;
        }
        const result = searchFileContent({
          candidate,
          content,
          terms: request.terms,
          includeContent,
          snippetLines,
          sourceName: normalizedOptions.name,
        });
        if (result) {
          results.push(result);
          await request.emitDelta?.('file matched', {
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
        scannedFiles,
        skippedFiles,
        metadata: {
          provider: 'local-fs',
          source: normalizedOptions.name,
        },
      };
    },
  };
}
