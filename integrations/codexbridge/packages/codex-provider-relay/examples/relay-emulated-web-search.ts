import {
  CodexProviderRuntime,
  createCodexProviderWebSearchExecutor,
} from '@codex-provider/core';

const webSearch = createCodexProviderWebSearchExecutor({
  provider: 'tavily',
  apiKey: mustGetEnv('TAVILY_API_KEY'),
  maxResults: 5,
});

const runtime = new CodexProviderRuntime({
  apiKey: mustGetEnv('OPENROUTER_API_KEY'),
  upstreamBaseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-chat',
  providerLabel: 'openrouter',
  profileMode: 'mixed',
  toolStrategy: 'relay-emulated',
  hostedTools: [{ name: 'web_search', mode: 'relay-emulated' }],
  hostedToolExecutors: { web_search: webSearch },
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
