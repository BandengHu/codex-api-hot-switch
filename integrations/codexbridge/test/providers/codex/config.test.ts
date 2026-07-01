import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadCodexProfilesFromEnv, resolveCommand } from '../../../src/providers/codex/config.js';

test('loadCodexProfilesFromEnv keeps Codex OpenAI as the default profile', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_COMPAT_PROVIDER_ID: 'compat-example',
    CODEX_COMPAT_PROVIDER_NAME: 'Compatible Example',
    CODEX_COMPAT_API_KEY: 'sk-test',
    CODEX_COMPAT_BASE_URL: 'https://provider.example/v1',
    CODEX_COMPAT_DEFAULT_MODEL: 'example-model',
  });

  assert.equal(result.defaultProviderProfileId, 'openai-default');
  assert.equal(result.profiles[0]?.providerKind, 'openai-native');
  assert.equal(result.profiles[0]?.config.cliBin, '/usr/bin/codex');
  assert.equal(result.profiles[1]?.id, 'compat-example');
  assert.equal(result.profiles[1]?.providerKind, 'openai-compatible');
  assert.equal(result.profiles[1]?.config.apiKeyEnv, 'CODEX_COMPAT_API_KEY');
  assert.equal(result.profiles[1]?.config.baseUrl, 'https://provider.example/v1');
  assert.equal(result.profiles[1]?.config.defaultModel, 'example-model');
});

test('loadCodexProfilesFromEnv exposes multiple JSON-defined compatible providers', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_COMPAT_PROFILES_JSON: JSON.stringify([{
      id: 'groq',
      displayName: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-3.3-70b-versatile',
      capabilityPreset: 'default',
      modelIds: ['llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct-0905'],
    }, {
      id: 'together',
      displayName: 'Together',
      apiKeyEnv: 'TOGETHER_API_KEY',
      baseUrl: 'https://api.together.xyz/v1',
      defaultModel: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8',
      capabilityPreset: 'qwen',
      providerLabel: 'together',
    }]),
  });

  const groq = result.profiles.find((entry) => entry.id === 'groq');
  const together = result.profiles.find((entry) => entry.id === 'together');
  assert.equal(groq?.providerKind, 'openai-compatible');
  assert.equal(groq?.config.apiKeyEnv, 'GROQ_API_KEY');
  assert.equal(groq?.config.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(groq?.config.defaultModel, 'llama-3.3-70b-versatile');
  assert.deepEqual((groq?.config.modelCatalog as any[]).map((entry) => entry.id), [
    'llama-3.3-70b-versatile',
    'moonshotai/kimi-k2-instruct-0905',
  ]);
  assert.equal(together?.providerKind, 'openai-compatible');
  assert.equal(together?.config.apiKeyEnv, 'TOGETHER_API_KEY');
  assert.equal(together?.config.providerLabel, 'together');
  assert.equal(together?.config.capabilities?.multimodal?.supportsImageInput, false);
});

test('loadCodexProfilesFromEnv merges custom capability overrides for JSON-defined compatible providers', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_COMPAT_PROFILES_JSON: JSON.stringify([{
      id: 'custom-qwen',
      displayName: 'Custom Qwen',
      baseUrl: 'https://provider.example/v1',
      defaultModel: 'qwen-plus',
      capabilityPreset: 'qwen',
      capabilityOverrides: {
        supportsBuiltinWebSearchTool: true,
        retry: {
          maxAttempts: 4,
        },
        multimodal: {
          supportsImageInput: true,
        },
      },
    }]),
  });

  const profile = result.profiles.find((entry) => entry.id === 'custom-qwen');
  assert.equal(profile?.providerKind, 'openai-compatible');
  assert.equal(profile?.config.capabilities?.supportsBuiltinWebSearchTool, true);
  assert.equal(profile?.config.capabilities?.retry?.maxAttempts, 4);
  assert.equal(profile?.config.capabilities?.multimodal?.supportsImageInput, true);
  assert.equal(profile?.config.capabilities?.multimodal?.supportsFileInput, false);
});

test('loadCodexProfilesFromEnv supports inline model catalogs for JSON-defined compatible providers', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-inline-model-catalog-'));
  const catalogPath = path.join(tempDir, 'compat-models.json');
  fs.writeFileSync(catalogPath, JSON.stringify({
    qwen: [{
      id: 'file-model',
      display_name: 'File Model',
      max_completion_tokens: 1024,
    }],
  }));

  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_COMPAT_PROFILES_JSON: JSON.stringify([{
      id: 'inline-catalog',
      displayName: 'Inline Catalog',
      baseUrl: 'https://provider.example/v1',
      defaultModel: 'inline-model',
      capabilityPreset: 'qwen',
      modelCatalogPath: catalogPath,
      modelCatalog: {
        qwen: [{
          id: 'inline-model',
          display_name: 'Inline Model',
          max_completion_tokens: 4096,
          thinking: {
            min: 128,
            max: 8192,
            zero_allowed: true,
          },
        }],
      },
    }]),
  });

  const profile = result.profiles.find((entry) => entry.id === 'inline-catalog');
  const model = (profile?.config.modelCatalog as any[])[0];
  assert.equal(model.id, 'inline-model');
  assert.equal(model.displayName, 'Inline Model');
  assert.equal(model.capabilities.maxOutputTokens, 4096);
  assert.equal(profile?.config.capabilities?.modelCapabilities?.['inline-model']?.maxOutputTokens, 4096);
  assert.equal((profile?.config.modelCatalog as any[]).some((entry) => entry.id === 'file-model'), false);
});

test('loadCodexProfilesFromEnv still accepts string capabilities as a preset alias', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_COMPAT_PROFILES_JSON: JSON.stringify([{
      id: 'alias-preset',
      displayName: 'Alias Preset',
      baseUrl: 'https://provider.example/v1',
      defaultModel: 'qwen-plus',
      capabilities: 'qwen',
    }]),
  });

  const profile = result.profiles.find((entry) => entry.id === 'alias-preset');
  assert.equal(profile?.providerKind, 'openai-compatible');
  assert.equal(profile?.config.capabilities?.multimodal?.supportsImageInput, false);
  assert.equal(profile?.config.capabilities?.multimodal?.supportsFileInput, false);
});

test('loadCodexProfilesFromEnv ignores invalid JSON-defined compatible providers', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_COMPAT_PROFILES_JSON: JSON.stringify([{
      id: 'missing-base-url',
      defaultModel: 'example-model',
    }, {
      id: 'missing-model',
      baseUrl: 'https://provider.example/v1',
    }]),
  });

  assert.equal(result.profiles.some((entry) => entry.id === 'missing-base-url'), false);
  assert.equal(result.profiles.some((entry) => entry.id === 'missing-model'), false);
});

test('loadCodexProfilesFromEnv exposes JSON-defined compatible providers from a file path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-compat-profiles-'));
  const profilePath = path.join(tempDir, 'compat-profiles.json');
  fs.writeFileSync(profilePath, JSON.stringify([{
    id: 'grok',
    displayName: 'Grok',
    apiKeyEnv: 'XAI_API_KEY',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-code-fast-1',
    capabilityPreset: 'default',
  }]));

  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_COMPAT_PROFILES_PATH: profilePath,
  });

  const grok = result.profiles.find((entry) => entry.id === 'grok');
  assert.equal(grok?.providerKind, 'openai-compatible');
  assert.equal(grok?.displayName, 'Grok');
  assert.equal(grok?.config.apiKeyEnv, 'XAI_API_KEY');
  assert.equal(grok?.config.baseUrl, 'https://api.x.ai/v1');
  assert.equal(grok?.config.defaultModel, 'grok-code-fast-1');
});

test('loadCodexProfilesFromEnv prefers inline JSON-defined compatible providers over file duplicates', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-compat-precedence-'));
  const profilePath = path.join(tempDir, 'compat-profiles.json');
  fs.writeFileSync(profilePath, JSON.stringify([{
    id: 'groq',
    displayName: 'Groq File',
    baseUrl: 'https://file.example/v1',
    defaultModel: 'file-model',
  }]));

  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_COMPAT_PROFILES_JSON: JSON.stringify([{
      id: 'groq',
      displayName: 'Groq Inline',
      baseUrl: 'https://inline.example/v1',
      defaultModel: 'inline-model',
    }]),
    CODEX_COMPAT_PROFILES_PATH: profilePath,
  });

  const groq = result.profiles.find((entry) => entry.id === 'groq');
  assert.equal(groq?.displayName, 'Groq Inline');
  assert.equal(groq?.config.baseUrl, 'https://inline.example/v1');
  assert.equal(groq?.config.defaultModel, 'inline-model');
});

test('loadCodexProfilesFromEnv exposes DeepSeek through the generic OpenAI-compatible profile loader', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_DEFAULT_PROVIDER_PROFILE_ID: 'deepseek',
    DEEPSEEK_API_KEY: 'sk-test',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
    DEEPSEEK_DEFAULT_MODEL: 'deepseek-v4-pro',
  });

  const profile = result.profiles.find((entry) => entry.id === 'deepseek');
  assert.equal(result.defaultProviderProfileId, 'deepseek');
  assert.equal(profile?.providerKind, 'openai-compatible');
  assert.equal(profile?.displayName, 'DeepSeek');
  assert.equal(profile?.config.cliBin, '/usr/bin/codex');
  assert.equal(profile?.config.apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(profile?.config.baseUrl, 'https://api.deepseek.com');
  assert.equal(profile?.config.defaultModel, 'deepseek-v4-pro');
  assert.equal(profile?.config.providerLabel, 'deepseek');
  assert.equal(profile?.config.capabilities?.supportsBuiltinWebSearchTool, false);
  assert.equal(profile?.config.modelCatalogMode, 'overlay-only');
});

test('loadCodexProfilesFromEnv exposes MiniMax through the generic OpenAI-compatible profile loader', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_DEFAULT_PROVIDER_PROFILE_ID: 'minimax',
    MINIMAX_API_KEY: 'sk-test',
    MINIMAX_BASE_URL: 'https://api.minimaxi.com/v1',
    MINIMAX_MODEL: 'MiniMax-M2.7',
  });

  const profile = result.profiles.find((entry) => entry.id === 'minimax');
  assert.equal(result.defaultProviderProfileId, 'minimax');
  assert.equal(profile?.providerKind, 'openai-compatible');
  assert.equal(profile?.displayName, 'MiniMax');
  assert.equal(profile?.config.cliBin, '/usr/bin/codex');
  assert.equal(profile?.config.apiKeyEnv, 'MINIMAX_API_KEY');
  assert.equal(profile?.config.baseUrl, 'https://api.minimaxi.com/v1');
  assert.equal(profile?.config.defaultModel, 'MiniMax-M2.7');
  assert.equal(profile?.config.providerLabel, 'minimax');
  assert.equal(profile?.config.capabilities?.supportsBuiltinWebSearchTool, false);
  assert.equal(profile?.config.modelCatalogMode, 'overlay-only');
});

test('loadCodexProfilesFromEnv exposes additional CLIProxy-style compatible presets', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    KIMI_API_KEY: 'sk-kimi',
    GEMINI_API_KEY: 'sk-gemini',
    IFLOW_API_KEY: 'sk-iflow',
  });

  const kimi = result.profiles.find((entry) => entry.id === 'kimi');
  const gemini = result.profiles.find((entry) => entry.id === 'gemini');
  const iflow = result.profiles.find((entry) => entry.id === 'iflow');
  assert.equal(kimi?.providerKind, 'openai-compatible');
  assert.equal(kimi?.config.baseUrl, 'https://api.kimi.com/coding');
  assert.equal(kimi?.config.defaultModel, 'kimi-k2');
  assert.equal(gemini?.providerKind, 'openai-compatible');
  assert.equal(gemini?.config.defaultModel, 'gemini-2.5-pro');
  assert.equal(iflow?.providerKind, 'openai-compatible');
  assert.equal(iflow?.config.defaultModel, 'qwen3-coder-plus');
});

test('loadCodexProfilesFromEnv exposes Qwen through DashScope-compatible env aliases', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    DASHSCOPE_API_KEY: 'sk-dashscope',
    DASHSCOPE_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    DASHSCOPE_MODEL: 'qwen-max',
  });

  const profile = result.profiles.find((entry) => entry.id === 'qwen');
  assert.equal(profile?.providerKind, 'openai-compatible');
  assert.equal(profile?.config.apiKeyEnv, 'DASHSCOPE_API_KEY');
  assert.equal(profile?.config.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(profile?.config.defaultModel, 'qwen-max');
});

test('loadCodexProfilesFromEnv imports CLIProxyAPI models.json shaped catalogs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-cliproxy-catalog-'));
  const catalogPath = path.join(tempDir, 'models.json');
  fs.writeFileSync(catalogPath, JSON.stringify({
    qwen: [{
      id: 'qwen-test',
      object: 'model',
      owned_by: 'qwen',
      display_name: 'Qwen Test',
      description: 'Imported from CLIProxy-style catalog',
      max_completion_tokens: 12345,
      thinking: {
        min: 128,
        max: 8192,
        zero_allowed: true,
      },
    }],
  }));

  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    CODEX_COMPAT_PROVIDER_ID: 'compat-catalog',
    CODEX_COMPAT_API_KEY: 'sk-test',
    CODEX_COMPAT_DEFAULT_MODEL: 'qwen-test',
    CODEX_COMPAT_MODEL_CATALOG_PATH: catalogPath,
  });

  const profile = result.profiles.find((entry) => entry.id === 'compat-catalog');
  const model = (profile?.config.modelCatalog as any[])[0];
  assert.equal(model.id, 'qwen-test');
  assert.equal(model.displayName, 'Qwen Test');
  assert.equal(model.capabilities.maxOutputTokens, 12345);
  assert.deepEqual(model.supportedReasoningEfforts, ['none', 'low', 'medium', 'high']);
  assert.equal(profile?.config.capabilities?.modelCapabilities?.['qwen-test'].maxOutputTokens, 12345);
});

test('loadCodexProfilesFromEnv maps compatible provider retry env to capabilities', () => {
  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '/usr/bin/codex',
    MINIMAX_API_KEY: 'sk-test',
    MINIMAX_REQUEST_RETRY: '2',
    MINIMAX_RETRY_STATUSES: '429,503',
    MINIMAX_MAX_RETRY_INTERVAL: '5',
    MINIMAX_RETRY_NETWORK_ERRORS: 'true',
  });

  const profile = result.profiles.find((entry) => entry.id === 'minimax');
  assert.equal(profile?.config.capabilities?.retry?.maxAttempts, 3);
  assert.deepEqual(profile?.config.capabilities?.retry?.retryStatuses, [429, 503]);
  assert.equal(profile?.config.capabilities?.retry?.retryAfterMaxMs, 5000);
  assert.equal(profile?.config.capabilities?.retry?.maxDelayMs, 5000);
  assert.equal(profile?.config.capabilities?.retry?.retryNetworkErrors, true);
});

test('resolveCommand prefers codex.exe before wrapper scripts on Windows', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-config-win-path-'));
  fs.writeFileSync(path.join(tempDir, 'codex.cmd'), '@echo off\r\n');
  fs.writeFileSync(path.join(tempDir, 'codex.exe'), 'binary');

  const resolved = resolveCommand('codex', {
    platform: 'win32',
    env: {
      PATH: tempDir,
      PATHEXT: '.CMD;.EXE',
    } as NodeJS.ProcessEnv,
    cwd: tempDir,
  });

  assert.equal(resolved, path.join(tempDir, 'codex.exe'));
});

test('resolveCommand falls back to codex.cmd on Windows when no native executable is present', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-config-win-cmd-'));
  fs.writeFileSync(path.join(tempDir, 'codex.cmd'), '@echo off\r\n');

  const resolved = resolveCommand('codex', {
    platform: 'win32',
    env: {
      PATH: tempDir,
      PATHEXT: '.CMD;.BAT',
    } as NodeJS.ProcessEnv,
    cwd: tempDir,
  });

  assert.equal(resolved, path.join(tempDir, 'codex.cmd'));
});

test('loadCodexProfilesFromEnv resolves explicit Windows command overrides without requiring the extension', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-config-win-override-'));
  const toolDir = path.join(tempDir, 'tools');
  fs.mkdirSync(toolDir, { recursive: true });
  fs.writeFileSync(path.join(toolDir, 'codex.cmd'), '@echo off\r\n');

  const result = loadCodexProfilesFromEnv({
    CODEX_REAL_BIN: '.\\tools\\codex',
  } as NodeJS.ProcessEnv, {
    platform: 'win32',
    cwd: tempDir,
  });

  assert.equal(result.profiles[0]?.config.cliBin, path.join(toolDir, 'codex.cmd'));
});
