import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authModeForProfileMode,
  buildCodexProviderRelayProfile,
  codexBaseUrlForProfile,
  defaultProtocolForProfileMode,
} from '../src/index.js';

test('official profile points Codex directly at a Responses-compatible upstream', () => {
  const profile = buildCodexProviderRelayProfile({
    mode: 'official',
    providerLabel: 'openai official',
    upstreamBaseUrl: 'https://api.openai.com/v1/',
    defaultModel: 'gpt-5.4',
    supportsWebsockets: true,
  });

  assert.equal(profile.mode, 'official');
  assert.equal(profile.providerLabel, 'openai_official');
  assert.equal(profile.relayProtocol, 'responses');
  assert.equal(profile.authMode, 'codex-auth-compatible');
  assert.equal(profile.upstreamBaseUrl, 'https://api.openai.com/v1');
  assert.equal(profile.codexBaseUrl, 'https://api.openai.com/v1');
  assert.equal(profile.needsLocalResponsesAdapter, false);
  assert.deepEqual(profile.hostedTools, []);
  assert.ok(profile.codexCliArgs.includes('model_providers.openai_official.requires_openai_auth=true'));
  assert.ok(profile.codexCliArgs.includes('model_providers.openai_official.supports_websockets=true'));
});

test('mixed profile uses a local Responses adapter while keeping Codex auth compatibility', () => {
  const profile = buildCodexProviderRelayProfile({
    mode: 'mixed',
    providerLabel: 'deepseek',
    providerName: 'DeepSeek Mixed Relay',
    upstreamBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-pro',
    experimentalBearerToken: 'sk-upstream',
    protocolProxyPort: 58011,
  });

  assert.equal(profile.mode, 'mixed');
  assert.equal(profile.providerName, 'DeepSeek Mixed Relay');
  assert.equal(profile.relayProtocol, 'chat-completions');
  assert.equal(profile.authMode, 'codex-auth-compatible');
  assert.equal(profile.codexBaseUrl, 'http://127.0.0.1:58011/v1');
  assert.equal(profile.needsLocalResponsesAdapter, true);
  assert.deepEqual(profile.hostedTools, []);
  assert.ok(profile.codexCliArgs.includes('model_providers.deepseek.requires_openai_auth=true'));
  assert.ok(profile.codexCliArgs.includes('model_providers.deepseek.experimental_bearer_token="sk-upstream"'));
});

test('pure-api profile uses env-key auth through the local Responses adapter', () => {
  const profile = buildCodexProviderRelayProfile({
    mode: 'pure-api',
    providerLabel: 'openrouter',
    upstreamBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-3.1-pro-preview',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    protocolProxyPort: 58012,
  });

  assert.equal(profile.mode, 'pure-api');
  assert.equal(profile.relayProtocol, 'chat-completions');
  assert.equal(profile.authMode, 'api-key-compatible');
  assert.equal(profile.toolStrategy, 'codex-local-first');
  assert.equal(profile.codexBaseUrl, 'http://127.0.0.1:58012/v1');
  assert.equal(profile.needsLocalResponsesAdapter, true);
  assert.deepEqual(profile.hostedTools, []);
  assert.ok(profile.codexCliArgs.includes('model_providers.openrouter.requires_openai_auth=false'));
  assert.ok(profile.codexCliArgs.includes('model_providers.openrouter.env_key="OPENROUTER_API_KEY"'));
});

test('provider-native hosted tools must be declared explicitly', () => {
  const profile = buildCodexProviderRelayProfile({
    mode: 'official',
    providerLabel: 'openai',
    upstreamBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.4',
    toolStrategy: 'provider-native',
    hostedTools: [{
      name: 'web_search',
      mode: 'provider-native',
      providerToolName: 'web_search_preview',
      description: 'OpenAI hosted web search.',
    }],
  });

  assert.deepEqual(profile.hostedTools, [{
    name: 'web_search',
    mode: 'provider-native',
    providerToolName: 'web_search_preview',
    relayToolName: null,
    description: 'OpenAI hosted web search.',
  }]);
  assert.throws(() => buildCodexProviderRelayProfile({
    mode: 'official',
    providerLabel: 'bad',
    upstreamBaseUrl: 'https://api.example.com/v1',
    defaultModel: 'example',
    toolStrategy: 'provider-native',
  }), /requires at least one explicit hosted tool/u);
});

test('relay-emulated hosted tools must match the profile strategy', () => {
  const profile = buildCodexProviderRelayProfile({
    mode: 'mixed',
    providerLabel: 'relay-search',
    upstreamBaseUrl: 'https://api.example.com/v1',
    defaultModel: 'example',
    toolStrategy: 'relay-emulated',
    hostedTools: [{
      name: 'file_search',
      mode: 'relay-emulated',
      relayToolName: 'mcp_file_search',
    }],
  });

  assert.deepEqual(profile.hostedTools, [{
    name: 'file_search',
    mode: 'relay-emulated',
    providerToolName: null,
    relayToolName: 'mcp_file_search',
    description: null,
  }]);
  assert.throws(() => buildCodexProviderRelayProfile({
    mode: 'mixed',
    providerLabel: 'bad-relay',
    upstreamBaseUrl: 'https://api.example.com/v1',
    defaultModel: 'example',
    toolStrategy: 'relay-emulated',
    hostedTools: [{
      name: 'web_search',
      mode: 'provider-native',
    }],
  }), /declares provider-native, but profile strategy is relay-emulated/u);
});

test('profile helper defaults are explicit and reusable by external app-servers', () => {
  assert.equal(defaultProtocolForProfileMode('official'), 'responses');
  assert.equal(defaultProtocolForProfileMode('mixed'), 'chat-completions');
  assert.equal(defaultProtocolForProfileMode('pure-api'), 'chat-completions');
  assert.equal(authModeForProfileMode('official'), 'codex-auth-compatible');
  assert.equal(authModeForProfileMode('mixed'), 'codex-auth-compatible');
  assert.equal(authModeForProfileMode('pure-api'), 'api-key-compatible');
  assert.equal(codexBaseUrlForProfile({
    mode: 'mixed',
    upstreamBaseUrl: 'https://api.example.com/v1',
    protocolProxyPort: 58013,
  }), 'http://127.0.0.1:58013/v1');
});
