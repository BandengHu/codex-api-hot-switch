import type {
  CodexProviderRelayFileSearchSource,
  CodexProviderRelayFileSearchSourceMatch,
  CodexProviderRelayFileSearchSourceRequest,
  CodexProviderRelayFileSearchSourceResult,
  CodexProviderRelayInMemoryVectorFileSearchSourceOptions,
  EmbeddedMemoryFileSearchDocument,
  NormalizedInMemoryVectorFileSearchOptions,
} from '../types.js';
import {
  clampInteger,
  clampNumber,
  cosineSimilarity,
  createFileSearchSourceMatchFromDocument,
  lexicalScoreForText,
  normalizeEmbeddingVector,
  normalizeString,
  pathMatchesGlob,
} from '../shared.js';
import {
  embeddingTextForMemoryDocument,
  normalizeMemoryFileSearchDocument,
} from './memory.js';

export function createCodexProviderRelayInMemoryVectorFileSearchSource(
  options: CodexProviderRelayInMemoryVectorFileSearchSourceOptions,
): CodexProviderRelayFileSearchSource {
  const normalizedOptions = normalizeInMemoryVectorFileSearchOptions(options);
  let indexedDocumentsPromise: Promise<EmbeddedMemoryFileSearchDocument[]> | null = null;
  return {
    name: normalizedOptions.name,
    type: 'in-memory-vector',
    async search(request: CodexProviderRelayFileSearchSourceRequest): Promise<CodexProviderRelayFileSearchSourceResult> {
      const maxResults = request.maxResults;
      const includeContent = typeof request.includeContent === 'boolean'
        ? request.includeContent
        : normalizedOptions.includeContent;
      const maxBytesPerDocument = Math.min(request.maxBytesPerFile, normalizedOptions.maxBytesPerDocument);
      const snippetLines = Math.min(request.snippetLines, normalizedOptions.snippetLines);
      indexedDocumentsPromise ??= embedMemoryDocuments(normalizedOptions);
      const indexedDocuments = await indexedDocumentsPromise;

      await request.emitDelta?.('querying in-memory vector index', {
        source: normalizedOptions.name,
        documentCount: indexedDocuments.length,
        embeddingModel: normalizedOptions.embeddingProvider.model,
        maxResults,
      });

      const queryEmbedding = (await normalizedOptions.embeddingProvider.embed([request.query])).embeddings[0];
      if (!queryEmbedding || queryEmbedding.length === 0) {
        return {
          results: [],
          scannedFiles: 0,
          skippedFiles: 0,
        };
      }

      const textWeight = request.rankingOptions.hybridSearch?.textWeight ?? normalizedOptions.textWeight;
      const vectorWeight = request.rankingOptions.hybridSearch?.embeddingWeight ?? normalizedOptions.vectorWeight;
      const scored: CodexProviderRelayFileSearchSourceMatch[] = [];
      let scannedDocuments = 0;
      let skippedDocuments = 0;
      for (const entry of indexedDocuments) {
        const document = entry.document;
        if (scannedDocuments >= normalizedOptions.maxDocumentsScanned) {
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
        const vectorScore = cosineSimilarity(queryEmbedding, entry.embedding);
        const lexicalScore = lexicalScoreForText({
          title: document.title,
          path: document.path,
          content: document.content,
          terms: request.terms,
        });
        if (vectorScore <= 0 && lexicalScore <= 0) {
          continue;
        }
        const normalizedLexicalScore = Math.min(1, lexicalScore / 40);
        const score = (vectorScore * vectorWeight * 100) + (normalizedLexicalScore * textWeight * 100);
        const result = createFileSearchSourceMatchFromDocument({
          document,
          sourceName: normalizedOptions.name,
          sourceType: 'in-memory-vector',
          score,
          includeContent,
          snippetLines,
          terms: request.terms,
          attributes: {
            ...document.metadata,
            embedding_model: normalizedOptions.embeddingProvider.model,
            vector_score: Number(vectorScore.toFixed(6)),
            lexical_score: Number(normalizedLexicalScore.toFixed(6)),
          },
        });
        if (result) {
          scored.push(result);
          await request.emitDelta?.('in-memory vector document matched', {
            source: normalizedOptions.name,
            path: result.path,
            score: result.score,
            resultCount: scored.length,
          });
        }
      }

      scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
      return {
        results: scored.slice(0, maxResults),
        scannedFiles: scannedDocuments,
        skippedFiles: skippedDocuments,
        metadata: {
          provider: 'in-memory-vector',
          source: normalizedOptions.name,
          embeddingModel: normalizedOptions.embeddingProvider.model,
          scannedDocuments,
          skippedDocuments,
        },
      };
    },
  };
}

function normalizeInMemoryVectorFileSearchOptions(
  options: CodexProviderRelayInMemoryVectorFileSearchSourceOptions,
): NormalizedInMemoryVectorFileSearchOptions {
  const embeddingProvider = options.embeddingProvider;
  if (!embeddingProvider || typeof embeddingProvider.embed !== 'function') {
    throw new Error('in-memory-vector file_search source requires an embedding provider.');
  }
  const documents = Array.isArray(options.documents)
    ? options.documents.map(normalizeMemoryFileSearchDocument).filter(Boolean)
    : [];
  return {
    name: normalizeString(options.name) || 'in-memory-vector',
    type: 'in-memory-vector',
    documents,
    embeddingProvider,
    maxDocumentsScanned: clampInteger(options.maxDocumentsScanned, 1, 100_000, 5_000),
    maxBytesPerDocument: clampInteger(options.maxBytesPerDocument, 1_024, 2 * 1024 * 1024, 256 * 1024),
    snippetLines: clampInteger(options.snippetLines, 1, 8, 2),
    includeContent: options.includeContent !== false,
    vectorWeight: clampNumber(options.vectorWeight, 0, 1, 0.7),
    textWeight: clampNumber(options.textWeight, 0, 1, 0.3),
  };
}

async function embedMemoryDocuments(
  options: NormalizedInMemoryVectorFileSearchOptions,
): Promise<EmbeddedMemoryFileSearchDocument[]> {
  if (options.documents.length === 0) {
    return [];
  }
  const input = options.documents.map((document) => embeddingTextForMemoryDocument(document));
  const result = await options.embeddingProvider.embed(input);
  const embeddedDocuments: EmbeddedMemoryFileSearchDocument[] = [];
  for (let index = 0; index < options.documents.length; index += 1) {
    const embedding = normalizeEmbeddingVector(result.embeddings[index]);
    if (embedding.length === 0) {
      continue;
    }
    embeddedDocuments.push({
      document: options.documents[index],
      embedding,
    });
  }
  return embeddedDocuments;
}
