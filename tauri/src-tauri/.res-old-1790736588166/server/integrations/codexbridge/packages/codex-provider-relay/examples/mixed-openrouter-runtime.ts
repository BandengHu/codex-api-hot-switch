import {
  CodexProviderRuntime,
} from '@codex-provider/core';

const runtime = new CodexProviderRuntime({
  apiKey: mustGetEnv('OPENROUTER_API_KEY'),
  upstreamBaseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-chat',
  providerLabel: 'openrouter',
  providerName: 'OpenRouter',
  profileMode: 'mixed',
  toolStrategy: 'codex-local-first',
});

const state = await runtime.start();

console.log('Relay adapter:', state.adapterBaseUrl);
console.log('Codex base URL:', state.codexBaseUrl);
console.log('Codex CLI args:', state.codexCliArgs.join(' '));

function mustGetEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
