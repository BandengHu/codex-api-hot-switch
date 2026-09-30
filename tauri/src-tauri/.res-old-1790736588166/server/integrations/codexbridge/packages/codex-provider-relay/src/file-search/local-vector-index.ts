import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CandidateFile,
  CodexProviderRelayEmbeddingProvider,
  CodexProviderRelayEmbeddingProviderResult,
  CodexProviderRelayFileSearchSourceMatch,
  CodexProviderRelayFileSearchSourceRequest,
  CodexProviderRelayFileSearchSourceResult,
  CodexProviderRelayLocalVectorIndexChunk,
  CodexProviderRelayLocalVectorIndexDocument,
  CodexProviderRelayLocalVectorIndexSearchChunksRequest,
  LocalVectorTextChunk,
  NormalizedLocalVectorChunkingOptions,
  NormalizedLocalVectorFileSearchOptions,
} from './types.js';
import {
  cosineSimilarity,
  lexicalScoreForText,
  looksBinary,
  normalizeEmbeddingVector,
  normalizeFileSearchAttributes,
  pathMatchesGlob,
  stableContentHash,
  stableFileSearchFileId,
} from './shared.js';
import { collectCandidateFiles } from './sources/local-shared.js';

const LOCAL_VECTOR_INDEX_VERSION = 'local-vector-index-v1';
const LOCAL_VECTOR_CHUNKER_VERSION = 'line-window-chunker-v1';
const LOCAL_VECTOR_RRF_K = 60;

type LocalVectorScoredChunk = {
  chunk: CodexProviderRelayLocalVectorIndexChunk;
  score: number;
  vectorScore: number;
  lexicalScore: number;
};

export function createCodexProviderRelayLocalVectorIndex(
  options: NormalizedLocalVectorFileSearchOptions,
): CodexProviderRelayLocalVectorIndex {
  return new CodexProviderRelayLocalVectorIndex(options);
}

class CodexProviderRelayLocalVectorIndex {
  constructor(private readonly options: NormalizedLocalVectorFileSearchOptions) {}

  async search(request: CodexProviderRelayFileSearchSourceRequest): Promise<CodexProviderRelayFileSearchSourceResult> {
    const maxResults = request.maxResults;
    const includeContent = typeof request.includeContent === 'boolean'
      ? request.includeContent
      : this.options.local.includeContent;
    const maxBytesPerFile = Math.min(request.maxBytesPerFile, this.options.local.maxBytesPerFile);

    await request.emitDelta?.('indexing local vector files', {
      source: this.options.name,
      roots: this.options.local.roots.map((root) => root.path),
      embeddingModel: this.options.embeddingProvider.model,
    });

    const candidates = await collectCandidateFiles(this.options.local, request.pathGlob);
    const staleDocumentIds = request.pathGlob
      ? []
      : await this.deleteStaleDocuments(candidates);
    if (staleDocumentIds.length > 0) {
      await request.emitDelta?.('local vector stale documents removed', {
        source: this.options.name,
        count: staleDocumentIds.length,
      });
    }

    let scannedFiles = 0;
    let skippedFiles = 0;
    let indexedFiles = 0;
    let cachedFiles = 0;
    const queryEmbedding = await embedSingleText(
      this.options.embeddingProvider,
      request.query,
      'local-vector query embedding',
    );
    const embeddingDimensions = queryEmbedding.length;
    if (embeddingDimensions === 0) {
      return {
        results: [],
        scannedFiles,
        skippedFiles,
        metadata: {
          provider: 'local-vector',
          source: this.options.name,
          indexedFiles,
          cachedFiles,
        },
      };
    }
    for (const candidate of candidates) {
      if (scannedFiles >= this.options.local.maxFilesScanned) {
        break;
      }
      scannedFiles += 1;
      const indexResult = await this.indexCandidate({
        candidate,
        maxBytesPerFile,
        embeddingDimensions,
      });
      if (indexResult.status === 'skipped') {
        skippedFiles += 1;
      } else if (indexResult.status === 'cached') {
        cachedFiles += 1;
        await request.emitDelta?.('local vector file cache hit', {
          source: this.options.name,
          path: candidate.relativePath,
        });
      } else {
        indexedFiles += 1;
        await request.emitDelta?.('local vector file indexed', {
          source: this.options.name,
          path: candidate.relativePath,
          chunkCount: indexResult.chunkCount,
        });
      }
    }

    await request.emitDelta?.('querying local vector index', {
      source: this.options.name,
      embeddingModel: this.options.embeddingProvider.model,
      indexedFiles,
      cachedFiles,
      maxResults,
    });

    const textWeight = request.rankingOptions.hybridSearch?.textWeight ?? this.options.textWeight;
    const vectorWeight = request.rankingOptions.hybridSearch?.embeddingWeight ?? this.options.vectorWeight;
    const chunks = await this.searchChunks({
      sourceName: this.options.name,
      query: request.query,
      terms: request.terms,
      pathGlob: request.pathGlob,
      queryEmbedding,
      maxResults,
      rankingOptions: request.rankingOptions,
    });
    const scoredChunks: LocalVectorScoredChunk[] = [];
    for (const chunk of chunks) {
      if (request.pathGlob && !pathMatchesGlob(chunk.path, request.pathGlob)) {
        continue;
      }
      if (chunk.embedding.length !== queryEmbedding.length) {
        continue;
      }
      const vectorScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      const lexicalScore = lexicalScoreForText({
        title: chunk.title,
        path: chunk.path,
        content: chunk.text,
        terms: request.terms,
      });
      if (vectorScore <= 0 && lexicalScore <= 0) {
        continue;
      }
      const normalizedLexicalScore = Math.min(1, lexicalScore / 40);
      scoredChunks.push({
        chunk,
        score: 0,
        vectorScore,
        lexicalScore: normalizedLexicalScore,
      });
    }

    if (isRrfRanker(request.rankingOptions.ranker)) {
      applyRrfScores(scoredChunks, vectorWeight, textWeight);
    } else {
      for (const entry of scoredChunks) {
        entry.score = (entry.vectorScore * vectorWeight * 100) + (entry.lexicalScore * textWeight * 100);
      }
    }

    const groupedResults = new Map<string, {
      chunkScores: LocalVectorScoredChunk[];
      maxVectorScore: number;
      maxLexicalScore: number;
      score: number;
    }>();
    for (const scoredChunk of scoredChunks) {
      if (scoredChunk.score <= 0) {
        continue;
      }
      const chunk = scoredChunk.chunk;
      const entry = groupedResults.get(chunk.documentId) ?? {
        chunkScores: [],
        maxVectorScore: 0,
        maxLexicalScore: 0,
        score: 0,
      };
      entry.chunkScores.push(scoredChunk);
      entry.score = Math.max(entry.score, scoredChunk.score);
      entry.maxVectorScore = Math.max(entry.maxVectorScore, scoredChunk.vectorScore);
      entry.maxLexicalScore = Math.max(entry.maxLexicalScore, scoredChunk.lexicalScore);
      groupedResults.set(chunk.documentId, entry);
    }

    const results: CodexProviderRelayFileSearchSourceMatch[] = [];
    for (const entry of groupedResults.values()) {
      entry.chunkScores.sort((left, right) => right.score - left.score || left.chunk.chunkIndex - right.chunk.chunkIndex);
      const bestChunk = entry.chunkScores[0]?.chunk;
      if (!bestChunk || entry.score <= 0) {
        continue;
      }
      const content = includeContent
        ? entry.chunkScores.slice(0, 4).map(({ chunk }) => ({
          type: 'text' as const,
          text: chunk.text.slice(0, 1_500),
          line: chunk.startLine,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
        }))
        : [];
      results.push({
        file_id: stableFileSearchFileId(this.options.name, bestChunk.path),
        filename: bestChunk.filename,
        title: bestChunk.title,
        uri: bestChunk.uri,
        path: bestChunk.path,
        root: bestChunk.root,
        source: this.options.name,
        sourceType: 'local-vector',
        score: entry.score,
        attributes: normalizeFileSearchAttributes({
          ...(bestChunk.metadata && typeof bestChunk.metadata === 'object' ? bestChunk.metadata : {}),
          filename: bestChunk.filename,
          path: bestChunk.path,
          root: bestChunk.root,
          source: this.options.name,
          source_type: 'local-vector',
          embedding_model: this.options.embeddingProvider.model,
          vector_score: Number(entry.maxVectorScore.toFixed(6)),
          lexical_score: Number(entry.maxLexicalScore.toFixed(6)),
          chunk_count: entry.chunkScores.length,
        }),
        content,
      });
      await request.emitDelta?.('local vector chunk matched', {
        source: this.options.name,
        path: bestChunk.path,
        score: entry.score,
        resultCount: results.length,
      });
    }

    results.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    return {
      results: results.slice(0, maxResults),
      scannedFiles,
      skippedFiles,
      metadata: {
        provider: 'local-vector',
        source: this.options.name,
        embeddingModel: this.options.embeddingProvider.model,
        indexedFiles,
        cachedFiles,
        chunkCount: chunks.length,
      },
    };
  }

  private async indexCandidate({
    candidate,
    maxBytesPerFile,
    embeddingDimensions,
  }: {
    candidate: CandidateFile;
    maxBytesPerFile: number;
    embeddingDimensions: number;
  }): Promise<{ status: 'cached' | 'indexed' | 'skipped'; chunkCount: number }> {
    const stat = await fs.stat(candidate.absolutePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.size > maxBytesPerFile) {
      return { status: 'skipped', chunkCount: 0 };
    }
    const documentId = localVectorDocumentId(this.options.name, candidate);
    const existingDocument = await this.options.indexStore.getDocument(documentId);
    const content = await fs.readFile(candidate.absolutePath, 'utf8').catch(() => null);
    if (!content || looksBinary(content)) {
      return { status: 'skipped', chunkCount: 0 };
    }
    const contentHash = stableContentHash(content);
    const fingerprint = createLocalVectorDocumentFingerprint({
      options: this.options,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash,
      embeddingDimensions,
    });
    if (
      existingDocument
      && localVectorDocumentMatchesFingerprint(existingDocument, fingerprint)
    ) {
      return { status: 'cached', chunkCount: 0 };
    }
    const textChunks = chunkLocalVectorText(content, this.options.chunking);
    if (textChunks.length === 0) {
      return { status: 'skipped', chunkCount: 0 };
    }
    const embeddings = await embedTextsInBatches(
      this.options.embeddingProvider,
      textChunks.map((chunk) => [
        candidate.relativePath,
        chunk.text,
      ].join('\n\n')),
      this.options.embeddingBatchSize,
      embeddingDimensions,
    );
    const filename = path.basename(candidate.relativePath) || candidate.relativePath;
    const document: CodexProviderRelayLocalVectorIndexDocument = {
      id: documentId,
      sourceName: this.options.name,
      root: candidate.root.path,
      path: candidate.relativePath,
      uri: pathToFileURL(candidate.absolutePath).toString(),
      title: candidate.relativePath,
      filename,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash,
      embeddingModel: this.options.embeddingProvider.model,
      indexVersion: fingerprint.indexVersion,
      chunkerVersion: fingerprint.chunkerVersion,
      chunkingConfigHash: fingerprint.chunkingConfigHash,
      embeddingDimensions: fingerprint.embeddingDimensions,
      contentHashAlgorithm: fingerprint.contentHashAlgorithm,
      statFingerprint: fingerprint.statFingerprint,
      updatedAt: new Date().toISOString(),
    };
    const chunks: CodexProviderRelayLocalVectorIndexChunk[] = [];
    for (let index = 0; index < textChunks.length; index += 1) {
      const embedding = normalizeEmbeddingVector(embeddings[index]);
      if (embedding.length === 0) {
        continue;
      }
      const textChunk = textChunks[index];
      chunks.push({
        id: stableFileSearchFileId(this.options.name, `${documentId}:${textChunk.chunkIndex}`),
        documentId,
        sourceName: this.options.name,
        root: candidate.root.path,
        path: candidate.relativePath,
        uri: document.uri,
        title: document.title,
        filename,
        text: textChunk.text,
        chunkIndex: textChunk.chunkIndex,
        startLine: textChunk.startLine,
        endLine: textChunk.endLine,
        embedding,
        metadata: {
          root: candidate.root.path,
          path: candidate.relativePath,
          filename,
          content_hash: contentHash,
          embedding_model: this.options.embeddingProvider.model,
          index_version: fingerprint.indexVersion,
          chunker_version: fingerprint.chunkerVersion,
          chunking_config_hash: fingerprint.chunkingConfigHash,
          embedding_dimensions: fingerprint.embeddingDimensions,
          content_hash_algorithm: fingerprint.contentHashAlgorithm,
          stat_fingerprint: fingerprint.statFingerprint,
        },
      });
    }
    if (chunks.length === 0) {
      return { status: 'skipped', chunkCount: 0 };
    }
    await this.options.indexStore.upsertDocument(document, chunks);
    return { status: 'indexed', chunkCount: chunks.length };
  }

  private async deleteStaleDocuments(candidates: CandidateFile[]): Promise<string[]> {
    const candidateIds = new Set(candidates.map((candidate) => localVectorDocumentId(this.options.name, candidate)));
    if (this.options.indexStore.deleteStaleDocuments) {
      return this.options.indexStore.deleteStaleDocuments(this.options.name, [...candidateIds]);
    }
    if (!this.options.indexStore.deleteDocuments) {
      return [];
    }
    const documentIds = this.options.indexStore.listDocuments
      ? (await this.options.indexStore.listDocuments(this.options.name)).map((document) => document.id)
      : [...new Set((await this.options.indexStore.listChunks(this.options.name)).map((chunk) => chunk.documentId))];
    const staleIds = [...new Set(documentIds)]
      .filter((documentId) => !candidateIds.has(documentId));
    if (staleIds.length > 0) {
      await this.options.indexStore.deleteDocuments(staleIds);
    }
    return staleIds;
  }

  private async searchChunks(
    request: CodexProviderRelayLocalVectorIndexSearchChunksRequest,
  ): Promise<CodexProviderRelayLocalVectorIndexChunk[]> {
    if (this.options.indexStore.searchChunks) {
      return this.options.indexStore.searchChunks(request);
    }
    return this.options.indexStore.listChunks(request.sourceName);
  }
}

function localVectorDocumentId(sourceName: string, candidate: CandidateFile): string {
  return stableFileSearchFileId(sourceName, `${candidate.root.path}:${candidate.relativePath}`);
}

function isRrfRanker(ranker: string): boolean {
  return ranker.toLowerCase() === 'rrf';
}

function applyRrfScores(
  scoredChunks: LocalVectorScoredChunk[],
  vectorWeight: number,
  textWeight: number,
): void {
  const denseRanks = rankScoredChunks(
    scoredChunks.filter((entry) => entry.vectorScore > 0),
    (left, right) => right.vectorScore - left.vectorScore || compareChunkPath(left, right),
  );
  const lexicalRanks = rankScoredChunks(
    scoredChunks.filter((entry) => entry.lexicalScore > 0),
    (left, right) => right.lexicalScore - left.lexicalScore || compareChunkPath(left, right),
  );
  for (const entry of scoredChunks) {
    const denseRank = denseRanks.get(entry);
    const lexicalRank = lexicalRanks.get(entry);
    const denseScore = denseRank ? vectorWeight * (1 / (LOCAL_VECTOR_RRF_K + denseRank)) : 0;
    const lexicalScore = lexicalRank ? textWeight * (1 / (LOCAL_VECTOR_RRF_K + lexicalRank)) : 0;
    entry.score = (denseScore + lexicalScore) * 100;
  }
}

function rankScoredChunks(
  entries: LocalVectorScoredChunk[],
  compare: (left: LocalVectorScoredChunk, right: LocalVectorScoredChunk) => number,
): Map<LocalVectorScoredChunk, number> {
  const ranks = new Map<LocalVectorScoredChunk, number>();
  [...entries]
    .sort(compare)
    .forEach((entry, index) => {
      ranks.set(entry, index + 1);
    });
  return ranks;
}

function compareChunkPath(left: LocalVectorScoredChunk, right: LocalVectorScoredChunk): number {
  return (
    left.chunk.path.localeCompare(right.chunk.path)
    || left.chunk.chunkIndex - right.chunk.chunkIndex
  );
}

function createLocalVectorDocumentFingerprint({
  options,
  size,
  mtimeMs,
  contentHash,
  embeddingDimensions,
}: {
  options: NormalizedLocalVectorFileSearchOptions;
  size: number;
  mtimeMs: number;
  contentHash: string;
  embeddingDimensions: number;
}): Required<Pick<
  CodexProviderRelayLocalVectorIndexDocument,
  | 'size'
  | 'mtimeMs'
  | 'contentHash'
  | 'embeddingModel'
  | 'indexVersion'
  | 'chunkerVersion'
  | 'chunkingConfigHash'
  | 'embeddingDimensions'
  | 'contentHashAlgorithm'
  | 'statFingerprint'
>> {
  return {
    size,
    mtimeMs,
    contentHash,
    embeddingModel: options.embeddingProvider.model,
    indexVersion: LOCAL_VECTOR_INDEX_VERSION,
    chunkerVersion: LOCAL_VECTOR_CHUNKER_VERSION,
    chunkingConfigHash: localVectorChunkingConfigHash(options.chunking),
    embeddingDimensions,
    contentHashAlgorithm: contentHash.split(':')[0] || 'unknown',
    statFingerprint: `${size}:${mtimeMs}`,
  };
}

function localVectorDocumentMatchesFingerprint(
  document: CodexProviderRelayLocalVectorIndexDocument,
  fingerprint: Required<Pick<
    CodexProviderRelayLocalVectorIndexDocument,
    | 'size'
    | 'mtimeMs'
    | 'contentHash'
    | 'embeddingModel'
    | 'indexVersion'
    | 'chunkerVersion'
    | 'chunkingConfigHash'
    | 'embeddingDimensions'
    | 'contentHashAlgorithm'
    | 'statFingerprint'
  >>,
): boolean {
  return (
    document.size === fingerprint.size
    && document.mtimeMs === fingerprint.mtimeMs
    && document.contentHash === fingerprint.contentHash
    && document.embeddingModel === fingerprint.embeddingModel
    && document.indexVersion === fingerprint.indexVersion
    && document.chunkerVersion === fingerprint.chunkerVersion
    && document.chunkingConfigHash === fingerprint.chunkingConfigHash
    && document.embeddingDimensions === fingerprint.embeddingDimensions
    && document.contentHashAlgorithm === fingerprint.contentHashAlgorithm
    && document.statFingerprint === fingerprint.statFingerprint
  );
}

function localVectorChunkingConfigHash(options: NormalizedLocalVectorChunkingOptions): string {
  return stableContentHash(JSON.stringify({
    chunkerVersion: LOCAL_VECTOR_CHUNKER_VERSION,
    maxChars: options.maxChars,
    overlapChars: options.overlapChars,
    maxChunksPerFile: options.maxChunksPerFile,
  }));
}

function chunkLocalVectorText(
  content: string,
  options: NormalizedLocalVectorChunkingOptions,
): LocalVectorTextChunk[] {
  const lines = content.split(/\r?\n/u);
  const chunks: LocalVectorTextChunk[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length && chunks.length < options.maxChunksPerFile) {
    const previousStartIndex = lineIndex;
    const startLine = lineIndex + 1;
    const selectedLines: string[] = [];
    let charCount = 0;
    while (lineIndex < lines.length) {
      const line = lines[lineIndex];
      const nextLength = charCount + line.length + (selectedLines.length > 0 ? 1 : 0);
      if (selectedLines.length > 0 && nextLength > options.maxChars) {
        break;
      }
      selectedLines.push(line);
      charCount = nextLength;
      lineIndex += 1;
      if (charCount >= options.maxChars) {
        break;
      }
    }
    if (selectedLines.length === 0) {
      const line = lines[lineIndex] ?? '';
      selectedLines.push(line.slice(0, options.maxChars));
      lineIndex += 1;
    }
    const endLine = Math.max(startLine, lineIndex);
    const text = selectedLines.join('\n').trim();
    if (text) {
      chunks.push({
        text,
        chunkIndex: chunks.length,
        startLine,
        endLine,
      });
    }
    if (options.overlapChars > 0 && lineIndex < lines.length) {
      const nextLineIndex = lineIndex;
      let overlapChars = 0;
      let overlapLineIndex = Math.max(0, lineIndex - 1);
      while (overlapLineIndex > 0 && overlapChars < options.overlapChars) {
        overlapChars += lines[overlapLineIndex].length + 1;
        overlapLineIndex -= 1;
      }
      lineIndex = Math.max(overlapLineIndex + 1, previousStartIndex + 1);
      if (lineIndex >= nextLineIndex) {
        lineIndex = nextLineIndex;
      }
    }
  }
  return chunks;
}

async function embedTextsInBatches(
  embeddingProvider: CodexProviderRelayEmbeddingProvider,
  texts: string[],
  batchSize: number,
  expectedDimensions: number,
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let index = 0; index < texts.length; index += batchSize) {
    const batch = texts.slice(index, index + batchSize);
    const result = await embeddingProvider.embed(batch);
    embeddings.push(...normalizeEmbeddingResult({
      result,
      expectedCount: batch.length,
      expectedDimensions,
      context: 'local-vector chunk embedding',
    }));
  }
  return embeddings;
}

async function embedSingleText(
  embeddingProvider: CodexProviderRelayEmbeddingProvider,
  text: string,
  context: string,
): Promise<number[]> {
  const result = await embeddingProvider.embed([text]);
  return normalizeEmbeddingResult({
    result,
    expectedCount: 1,
    expectedDimensions: null,
    context,
  })[0];
}

function normalizeEmbeddingResult({
  result,
  expectedCount,
  expectedDimensions,
  context,
}: {
  result: CodexProviderRelayEmbeddingProviderResult;
  expectedCount: number;
  expectedDimensions: number | null;
  context: string;
}): number[][] {
  if (!Array.isArray(result.embeddings)) {
    throw new Error(`${context} provider must return an embeddings array.`);
  }
  if (result.embeddings.length !== expectedCount) {
    throw new Error(`${context} provider returned ${result.embeddings.length} embeddings for ${expectedCount} inputs.`);
  }
  const embeddings = result.embeddings.map((embedding, index) => {
    const normalized = normalizeEmbeddingVector(embedding);
    if (normalized.length === 0) {
      throw new Error(`${context} provider returned an empty embedding at index ${index}.`);
    }
    return normalized;
  });
  const dimensions = expectedDimensions ?? embeddings[0]?.length ?? 0;
  for (const [index, embedding] of embeddings.entries()) {
    if (embedding.length !== dimensions) {
      throw new Error(`${context} provider returned embedding dimension ${embedding.length} at index ${index}; expected ${dimensions}.`);
    }
  }
  if (Number.isFinite(Number(result.dimensions)) && Number(result.dimensions) > 0 && Number(result.dimensions) !== dimensions) {
    throw new Error(`${context} provider reported dimensions ${result.dimensions}; expected ${dimensions}.`);
  }
  return embeddings;
}
