import {
  CodexProviderRuntime,
  createCodexProviderEmbeddingsApiProvider,
  createCodexProviderFileSearchExecutor,
} from '@codex-provider/core';

const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
const embeddings = createCodexProviderEmbeddingsApiProvider({
  apiKey: mustGetEnv('EMBEDDINGS_API_KEY'),
  endpoint: process.env.EMBEDDINGS_API_ENDPOINT,
  model: process.env.EMBEDDINGS_MODEL,
});

const fileSearch = createCodexProviderFileSearchExecutor({
  sources: [{
    type: 'local-vector',
    name: 'workspace-local-vector',
    roots: [workspaceRoot],
    embeddingProvider: embeddings,
    chunking: { maxChars: 1_600, overlapChars: 200 },
  }],
  includeContent: false,
  maxResults: 8,
  maxPayloadBytes: 48_000,
});

const runtime = new CodexProviderRuntime({
  apiKey: mustGetEnv('OPENROUTER_API_KEY'),
  upstreamBaseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-chat',
  providerLabel: 'openrouter',
  profileMode: 'mixed',
  toolStrategy: 'relay-emulated',
  hostedTools: [{ name: 'file_search', mode: 'relay-emulated' }],
  hostedToolExecutors: { file_search: fileSearch },
  emitHostedToolSseEvents: true,
});

await runtime.start();

function mustGetEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
