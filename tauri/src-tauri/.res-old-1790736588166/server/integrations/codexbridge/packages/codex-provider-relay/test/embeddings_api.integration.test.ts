import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodexProviderRelayEmbeddingsApiProvider,
} from '../src/index.js';

const shouldRun = process.env.CODEX_PROVIDER_RELAY_RUN_EMBEDDINGS_INTEGRATION === '1'
  && Boolean(process.env.EMBEDDINGS_API_KEY || process.env.OPENROUTER_API_KEY);

test('embeddings API provider returns real vectors', {
  skip: shouldRun
    ? false
    : 'set CODEX_PROVIDER_RELAY_RUN_EMBEDDINGS_INTEGRATION=1 and EMBEDDINGS_API_KEY to run',
}, async () => {
  const provider = createCodexProviderRelayEmbeddingsApiProvider({
    apiKey: process.env.EMBEDDINGS_API_KEY || process.env.OPENROUTER_API_KEY,
    endpoint: process.env.EMBEDDINGS_API_ENDPOINT || 'https://openrouter.ai/api/v1/embeddings',
    model: process.env.EMBEDDINGS_MODEL || 'qwen/qwen3-embedding-8b',
  });

  const result = await provider.embed([
    'Codex provider relay file search integration test',
    'Unrelated cooking recipe note',
  ]);

  assert.equal(result.embeddings.length, 2);
  assert.ok(result.embeddings[0].length > 100);
  assert.equal(result.embeddings[0].length, result.embeddings[1].length);
  assert.equal(result.model.length > 0, true);
});
