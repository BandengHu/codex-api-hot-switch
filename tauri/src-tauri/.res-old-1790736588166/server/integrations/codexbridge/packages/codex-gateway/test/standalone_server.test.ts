import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createCodexGatewayStandaloneServerConfigFromEnv,
  createCodexGatewayStandaloneServerFromEnv,
  loadCodexGatewayStandaloneEnvFile,
  resolveCodexGatewayStandaloneServerEnv,
} from '../src/index.js';

test('standalone server config resolves preset aliases and capability overrides from env', () => {
  const config = createCodexGatewayStandaloneServerConfigFromEnv({
    CODEX_GATEWAY_CAPABILITY_PRESET: 'qwen',
    DASHSCOPE_API_KEY: 'dashscope-key',
    DASHSCOPE_BASE_URL: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    DASHSCOPE_MODEL: 'qwen-plus-latest',
    CODEX_GATEWAY_CAPABILITY_OVERRIDES_JSON: JSON.stringify({
      supportsBuiltinWebSearchTool: true,
    }),
  });

  assert.equal(config.presetId, 'qwen');
  assert.equal(config.apiKey, 'dashscope-key');
  assert.equal(config.upstreamBaseUrl, 'https://dashscope-us.aliyuncs.com/compatible-mode/v1');
  assert.equal(config.defaultModel, 'qwen-plus-latest');
  assert.equal(config.providerName, 'Qwen');
  assert.equal(config.modelCatalogSource, 'preset');
  assert.equal(config.providerCapabilities?.supportsBuiltinWebSearchTool, true);
});

test('standalone server config loads inline external model catalogs from env JSON', async () => {
  const { config, server } = createCodexGatewayStandaloneServerFromEnv({
    CODEX_GATEWAY_CAPABILITY_PRESET: 'openrouter',
    OPENROUTER_API_KEY: 'openrouter-key',
    CODEX_GATEWAY_MODEL: 'openai/gpt-4.1-mini',
    CODEX_GATEWAY_MODEL_CATALOG_JSON: JSON.stringify({
      openrouter: [{
        id: 'openai/gpt-4.1-mini',
        display_name: 'OpenAI GPT-4.1 Mini',
        max_completion_tokens: 12345,
      }],
    }),
  });

  assert.equal(config.modelCatalogSource, 'json');
  assert.equal(config.models[0]?.id, 'openai/gpt-4.1-mini');
  assert.equal(config.providerCapabilities?.modelCapabilities?.['openai/gpt-4.1-mini']?.maxOutputTokens, 12345);

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/models`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.data[0].id, 'openai/gpt-4.1-mini');
    assert.equal(body.data[0].displayName, 'OpenAI GPT-4.1 Mini');
  } finally {
    await server.stop();
  }
});

test('standalone server config rejects empty external model catalogs', () => {
  assert.throws(
    () => createCodexGatewayStandaloneServerConfigFromEnv({
      CODEX_GATEWAY_CAPABILITY_PRESET: 'openrouter',
      OPENROUTER_API_KEY: 'openrouter-key',
      CODEX_GATEWAY_MODEL_CATALOG_JSON: JSON.stringify({ openrouter: [] }),
    }),
    /did not contain any model entries/,
  );
});

test('standalone server env file loader parses dotenv-style files and ignores invalid lines', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-env-file-'));
  const envFilePath = path.join(tempDir, 'gateway.env');
  fs.writeFileSync(envFilePath, [
    '# comment',
    'OPENROUTER_API_KEY=file-key',
    'CODEX_GATEWAY_MODEL="openai/gpt-4.1-mini"',
    'BAD LINE',
    '1BAD=value',
  ].join('\n'));

  const loaded = loadCodexGatewayStandaloneEnvFile(envFilePath);
  assert.equal(loaded.OPENROUTER_API_KEY, 'file-key');
  assert.equal(loaded.CODEX_GATEWAY_MODEL, 'openai/gpt-4.1-mini');
  assert.equal('BAD LINE' in loaded, false);
  assert.equal('1BAD' in loaded, false);
});

test('standalone server env resolution lets explicit env override env-file defaults', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-env-merge-'));
  const envFilePath = path.join(tempDir, 'gateway.env');
  fs.writeFileSync(envFilePath, [
    'OPENROUTER_API_KEY=file-key',
    'CODEX_GATEWAY_MODEL=openai/gpt-4.1-mini',
  ].join('\n'));

  const resolved = resolveCodexGatewayStandaloneServerEnv({
    env: {
      CODEX_GATEWAY_ENV_FILE: envFilePath,
      OPENROUTER_API_KEY: 'shell-key',
    },
  });

  assert.equal(resolved.OPENROUTER_API_KEY, 'shell-key');
  assert.equal(resolved.CODEX_GATEWAY_MODEL, 'openai/gpt-4.1-mini');
});

test('standalone server config loads provider defaults from CODEX_GATEWAY_ENV_FILE', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-gateway-config-env-'));
  const envFilePath = path.join(tempDir, 'gateway.env');
  fs.writeFileSync(envFilePath, [
    'CODEX_GATEWAY_CAPABILITY_PRESET=openrouter',
    'OPENROUTER_API_KEY=file-key',
    'OPENROUTER_MODEL=openai/gpt-4.1-mini',
  ].join('\n'));

  const config = createCodexGatewayStandaloneServerConfigFromEnv({
    CODEX_GATEWAY_ENV_FILE: envFilePath,
  });

  assert.equal(config.presetId, 'openrouter');
  assert.equal(config.apiKey, 'file-key');
  assert.equal(config.defaultModel, 'openai/gpt-4.1-mini');
});

test('standalone server config enables stderr-json trace mode from env', () => {
  const config = createCodexGatewayStandaloneServerConfigFromEnv({
    CODEX_GATEWAY_CAPABILITY_PRESET: 'openrouter',
    OPENROUTER_API_KEY: 'trace-key',
    CODEX_GATEWAY_TRACE: 'true',
  });

  assert.equal(config.traceMode, 'stderr-json');
});
