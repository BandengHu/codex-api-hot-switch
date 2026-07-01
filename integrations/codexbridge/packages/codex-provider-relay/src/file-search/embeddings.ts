import type {
  CodexProviderRelayEmbeddingProvider,
  CodexProviderRelayEmbeddingProviderEmbedOptions,
  CodexProviderRelayEmbeddingProviderResult,
  CodexProviderRelayEmbeddingsApiProviderOptions,
  CodexProviderRelayOpenRouterEmbeddingProviderOptions,
  JsonRecord,
} from './types.js';
import {
  isJsonRecord,
  normalizeEmbeddingVector,
  normalizeHeaders,
  normalizeString,
  parseJsonRecord,
} from './shared.js';

const DEFAULT_EMBEDDINGS_API_MODEL = 'qwen/qwen3-embedding-8b';
const DEFAULT_EMBEDDINGS_API_ENDPOINT = 'https://openrouter.ai/api/v1/embeddings';
const DEFAULT_OPENROUTER_EMBEDDING_MODEL = DEFAULT_EMBEDDINGS_API_MODEL;
const DEFAULT_OPENROUTER_EMBEDDINGS_ENDPOINT = DEFAULT_EMBEDDINGS_API_ENDPOINT;

export function createCodexProviderRelayEmbeddingsApiProvider(
  options: CodexProviderRelayEmbeddingsApiProviderOptions,
): CodexProviderRelayEmbeddingProvider {
  const apiKey = normalizeString(options.apiKey);
  const model = normalizeString(options.model) || DEFAULT_EMBEDDINGS_API_MODEL;
  const endpoint = normalizeString(options.endpoint) || DEFAULT_EMBEDDINGS_API_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const extraHeaders = normalizeHeaders(options.headers);
  const baseRequestBody = isJsonRecord(options.requestBody) ? options.requestBody : {};
  const responseParser = options.responseParser ?? normalizeEmbeddingsApiResponseData;
  return {
    model,
    async embed(
      input: string[],
      embedOptions: CodexProviderRelayEmbeddingProviderEmbedOptions = {},
    ): Promise<CodexProviderRelayEmbeddingProviderResult> {
      const texts = input.map(normalizeString).filter(Boolean);
      if (texts.length === 0) {
        return {
          model,
          embeddings: [],
          dimensions: null,
        };
      }
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal: embedOptions.signal ?? undefined,
        headers: {
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify({
          ...baseRequestBody,
          model,
          input: texts,
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Embeddings API provider returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      const body = parseJsonRecord(text, 'Embeddings API response');
      const embeddings = responseParser(body);
      return {
        model: normalizeString(body.model) || model,
        embeddings,
        dimensions: embeddings[0]?.length ?? null,
      };
    },
  };
}

export function createCodexProviderRelayOpenRouterEmbeddingProvider(
  options: CodexProviderRelayOpenRouterEmbeddingProviderOptions,
): CodexProviderRelayEmbeddingProvider {
  const apiKey = normalizeString(options.apiKey);
  if (!apiKey) {
    throw new Error('OpenRouter embedding provider requires an API key.');
  }
  return createCodexProviderRelayEmbeddingsApiProvider({
    ...options,
    apiKey,
    model: normalizeString(options.model) || DEFAULT_OPENROUTER_EMBEDDING_MODEL,
    endpoint: normalizeString(options.endpoint) || DEFAULT_OPENROUTER_EMBEDDINGS_ENDPOINT,
  });
}

function normalizeEmbeddingsApiResponseData(body: JsonRecord): number[][] {
  if (!Array.isArray(body.data)) {
    throw new Error('Embeddings API response data must be an array.');
  }
  return body.data.map((entry) => {
    const embedding = Array.isArray(entry)
      ? entry
      : Array.isArray(entry?.embedding)
        ? entry.embedding
        : [];
    return normalizeEmbeddingVector(embedding);
  });
}

