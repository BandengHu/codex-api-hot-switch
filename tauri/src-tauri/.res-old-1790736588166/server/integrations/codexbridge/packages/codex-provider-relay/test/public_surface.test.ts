import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assessCodexGatewayProtocolBoundary,
  buildCodexProviderConfig,
  buildCodexProviderProfile,
  CODEX_PROVIDER_DOES_NOT_OWN,
  CODEX_PROVIDER_OWNS,
  CODEX_PROVIDER_PACKAGE_NAME,
  CODEX_PROVIDER_PACKAGE_PHASE,
  CODEX_PROVIDER_RELEASE_CHANNEL,
  CODEX_PROVIDER_TARGET,
  CodexProviderHostedToolExecutorRegistry,
  CodexProviderRuntime,
  createCodexProviderCodeInterpreterExecutor,
  createCodexProviderComputerExecutor,
  createCodexProviderFileSearchExecutor,
  createCodexProviderHostedToolExecutorRegistry,
  createCodexProviderImageGenerationExecutor,
  createCodexProviderStandaloneServerConfigFromEnv,
  createCodexProviderStandaloneServerFromEnv,
  createCodexProviderToolSearchExecutor,
  createCodexProviderWebSearchExecutor,
  createCodexProviderRelayStandaloneServerConfigFromEnv,
  createCodexProviderRelayStandaloneServerFromEnv,
  CODEX_PROVIDER_RELAY_DOES_NOT_OWN,
  CODEX_PROVIDER_RELAY_OWNS,
  CODEX_PROVIDER_RELAY_PACKAGE_NAME,
  CODEX_PROVIDER_RELAY_PACKAGE_PHASE,
  CODEX_PROVIDER_RELAY_RELEASE_CHANNEL,
  LEGACY_CODEX_PROVIDER_RELAY_PACKAGE_NAME,
  loadCodexProviderRelayStandaloneEnvFile,
  loadCodexProviderStandaloneEnvFile,
  resolveCodexProviderRelayStandaloneServerEnv,
  resolveCodexProviderStandaloneServerEnv,
} from '../src/index.js';

test('codex provider relay package exposes the unified relay boundary contract', () => {
  assert.equal(CODEX_PROVIDER_PACKAGE_NAME, '@codex-provider/core');
  assert.equal(CODEX_PROVIDER_PACKAGE_PHASE, 'phase-1-public-api-rename-aliases');
  assert.equal(CODEX_PROVIDER_RELEASE_CHANNEL, 'internal-only');
  assert.equal(CODEX_PROVIDER_TARGET, 'Let non-OpenAI models participate in the Codex native tool-call loop.');
  assert.equal(CODEX_PROVIDER_OWNS.includes('codex-provider-config'), true);
  assert.equal(CODEX_PROVIDER_DOES_NOT_OWN.includes('codex-native-api'), true);

  assert.equal(CODEX_PROVIDER_RELAY_PACKAGE_NAME, '@codex-provider/core');
  assert.equal(LEGACY_CODEX_PROVIDER_RELAY_PACKAGE_NAME, '@codexbridge/codex-provider-relay');
  assert.equal(CODEX_PROVIDER_RELAY_PACKAGE_PHASE, 'phase-1-public-api-rename-aliases');
  assert.equal(CODEX_PROVIDER_RELAY_RELEASE_CHANNEL, 'internal-only');
  assert.ok(CODEX_PROVIDER_RELAY_OWNS.includes('codex-provider-config'));
  assert.ok(CODEX_PROVIDER_RELAY_OWNS.includes('responses-to-chat-conversion'));
  assert.ok(CODEX_PROVIDER_RELAY_OWNS.includes('local-responses-adapter-server'));
  assert.ok(CODEX_PROVIDER_RELAY_DOES_NOT_OWN.includes('codex-native-api'));
  assert.ok(CODEX_PROVIDER_RELAY_DOES_NOT_OWN.includes('wechat-transport'));
  assert.ok(CODEX_PROVIDER_RELAY_DOES_NOT_OWN.includes('assistant-records'));
  assert.equal(assessCodexGatewayProtocolBoundary('openai-chat-compatible').strategy, 'responses-to-chat-direct');
});

test('codex provider relay package metadata stays internal-only while the boundary stabilizes', () => {
  const packageJsonPath = path.resolve(import.meta.dirname, '../package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    bin?: Record<string, string>;
    description?: string;
    name?: string;
    private?: boolean;
    exports?: Record<string, unknown>;
    files?: string[];
    version?: string;
  };

  assert.equal(packageJson.name, '@codex-provider/core');
  assert.equal(packageJson.version, '0.1.0-alpha.0');
  assert.equal(packageJson.private, true);
  assert.equal(
    packageJson.description,
    'Provider compatibility SDK that lets non-OpenAI models participate in the Codex native tool-call loop.',
  );
  assert.deepEqual(Object.keys(packageJson.exports ?? {}).sort(), ['.', './package.json']);
  assert.equal(packageJson.bin?.['codex-provider-server'], './dist/cli.js');
  assert.equal(packageJson.bin?.['codex-provider-relay-server'], './dist/cli.js');
  assert.equal(packageJson.bin?.['codex-gateway-server'], './dist/cli.js');
  assert.deepEqual(packageJson.files, ['dist', 'README.md', 'docs', 'examples']);
});

test('codex provider relay package metadata and build layout stay aligned', () => {
  const packageJsonPath = path.resolve(import.meta.dirname, '../package.json');
  const tsconfigPath = path.resolve(import.meta.dirname, '../tsconfig.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    bin?: Record<string, string>;
    exports?: Record<string, { types?: string; default?: string } | string>;
    files?: string[];
  };
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as {
    compilerOptions?: { outDir?: string; rootDir?: string };
  };

  assert.equal(tsconfig.compilerOptions?.rootDir, 'src');
  assert.equal(tsconfig.compilerOptions?.outDir, 'dist');
  assert.equal((packageJson.exports?.['.'] as { types?: string })?.types, './dist/index.d.ts');
  assert.equal((packageJson.exports?.['.'] as { default?: string })?.default, './dist/index.js');
  assert.equal(packageJson.bin?.['codex-provider-server'], './dist/cli.js');
  assert.equal(packageJson.bin?.['codex-provider-relay-server'], './dist/cli.js');
  assert.equal(packageJson.bin?.['codex-gateway-server'], './dist/cli.js');
  assert.deepEqual(packageJson.files, ['dist', 'README.md', 'docs', 'examples']);
});

test('codex provider root scripts expose new commands and legacy relay aliases', () => {
  const rootPackageJsonPath = path.resolve(import.meta.dirname, '../../../package.json');
  const packageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.scripts?.['codex-provider:build'], 'tsc -p packages/codex-provider-relay/tsconfig.json');
  assert.equal(packageJson.scripts?.['codex-provider:test'], 'tsx --test packages/codex-provider-relay/test/*.test.ts');
  assert.equal(packageJson.scripts?.['codex-provider:typecheck'], 'tsc -p packages/codex-provider-relay/tsconfig.json --noEmit');
  assert.equal(packageJson.scripts?.['codex-provider:check-boundary'], 'node scripts/check-codex-provider-relay-boundary.mjs');
  assert.equal(packageJson.scripts?.['codex-provider-relay:build'], packageJson.scripts?.['codex-provider:build']);
  assert.equal(packageJson.scripts?.['codex-provider-relay:test'], packageJson.scripts?.['codex-provider:test']);
  assert.equal(packageJson.scripts?.['codex-provider-relay:typecheck'], packageJson.scripts?.['codex-provider:typecheck']);
  assert.equal(packageJson.scripts?.['codex-provider-relay:check-boundary'], packageJson.scripts?.['codex-provider:check-boundary']);
});

test('codex provider relay root entrypoint exports profile and protocol surfaces', () => {
  const indexPath = path.resolve(import.meta.dirname, '../src/index.ts');
  const source = fs.readFileSync(indexPath, 'utf8');

  assert.match(source, /export \* from '\.\/codex_config\.js'/);
  assert.match(source, /export \* from '\.\/builtin-tools\/index\.js'/);
  assert.match(source, /export \* from '\.\/code_interpreter_executor\.js'/);
  assert.match(source, /export \* from '\.\/computer_executor\.js'/);
  assert.match(source, /export \* from '\.\/image_generation_executor\.js'/);
  assert.match(source, /export \* from '\.\/runtime\.js'/);
  assert.match(source, /export \{\s*[\s\S]*getOpenAICompatibleProviderPreset/);
  assert.match(source, /export type \{\s*[\s\S]*OpenAICompatibleProviderCapabilities/);
  assert.match(source, /export \{\s*[\s\S]*OpenAICompatibleResponsesAdapterServer/);
  assert.match(source, /CodexProviderRelayTraceEvent/);
  assert.match(source, /createCodexProviderRelayStandaloneServerConfigFromEnv/);
  assert.match(source, /createCodexProviderRelayStandaloneServerFromEnv/);
  assert.match(source, /loadCodexProviderRelayStandaloneEnvFile/);
  assert.match(source, /resolveCodexProviderRelayStandaloneServerEnv/);

  assert.equal(typeof createCodexProviderRelayStandaloneServerConfigFromEnv, 'function');
  assert.equal(typeof createCodexProviderRelayStandaloneServerFromEnv, 'function');
  assert.equal(typeof loadCodexProviderRelayStandaloneEnvFile, 'function');
  assert.equal(typeof resolveCodexProviderRelayStandaloneServerEnv, 'function');
});

test('codex provider root entrypoint exposes new CodexProvider public API aliases', () => {
  assert.equal(CodexProviderRuntime.name, 'CodexProviderRelayRuntime');
  assert.equal(CodexProviderHostedToolExecutorRegistry.name, 'CodexProviderRelayHostedToolExecutorRegistry');
  assert.equal(typeof buildCodexProviderConfig, 'function');
  assert.equal(typeof buildCodexProviderProfile, 'function');
  assert.equal(typeof createCodexProviderFileSearchExecutor, 'function');
  assert.equal(typeof createCodexProviderWebSearchExecutor, 'function');
  assert.equal(typeof createCodexProviderToolSearchExecutor, 'function');
  assert.equal(typeof createCodexProviderImageGenerationExecutor, 'function');
  assert.equal(typeof createCodexProviderCodeInterpreterExecutor, 'function');
  assert.equal(typeof createCodexProviderComputerExecutor, 'function');
  assert.equal(typeof createCodexProviderHostedToolExecutorRegistry, 'function');
  assert.equal(typeof createCodexProviderStandaloneServerConfigFromEnv, 'function');
  assert.equal(typeof createCodexProviderStandaloneServerFromEnv, 'function');
  assert.equal(typeof loadCodexProviderStandaloneEnvFile, 'function');
  assert.equal(typeof resolveCodexProviderStandaloneServerEnv, 'function');

  const config = buildCodexProviderConfig({
    providerLabel: 'test-provider',
    relayBaseUrl: 'https://provider.example/v1',
    defaultModel: 'example-model',
  });
  assert.equal(config.providerLabel, 'test-provider');
  assert.equal(config.codexBaseUrl, 'https://provider.example/v1');
  assert.equal(config.entries.some((entry) => entry.key === 'model' && entry.value === 'example-model'), true);

  const registry = createCodexProviderHostedToolExecutorRegistry();
  assert.equal(registry instanceof CodexProviderHostedToolExecutorRegistry, true);
});

test('codex provider relay package includes public examples and package readiness docs', () => {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const requiredFiles = [
    'docs/OPENAI_BUILTIN_TOOL_COMPATIBILITY.md',
    'docs/INDEPENDENT_PACKAGE_CHECKLIST.md',
    'docs/LIVE_SMOKE_RECIPES.md',
    'docs/CODEX_PROVIDER_RENAME_AND_EXTRACTION_HANDOFF.md',
    'docs/RELEASE_READINESS.md',
    'docs/RECIPES.md',
    'docs/UNSAFE_TOOL_SECURITY.md',
    'examples/mixed-openrouter-runtime.ts',
    'examples/relay-emulated-web-search.ts',
    'examples/relay-emulated-file-search-local-vector.ts',
    'examples/relay-emulated-image-generation.ts',
    'examples/relay-emulated-code-interpreter-custom-executor.ts',
    'examples/codexnext-integration.ts',
  ];

  for (const relativePath of requiredFiles) {
    assert.equal(fs.existsSync(path.join(packageRoot, relativePath)), true, `${relativePath} should exist`);
  }
});

test('codex provider docs and examples prefer new product naming', () => {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const readPackageFile = (relativePath: string): string => fs.readFileSync(path.join(packageRoot, relativePath), 'utf8');

  const readme = readPackageFile('README.md');
  const recipes = readPackageFile('docs/RECIPES.md');
  const examples = [
    'examples/mixed-openrouter-runtime.ts',
    'examples/relay-emulated-web-search.ts',
    'examples/relay-emulated-file-search-local-vector.ts',
    'examples/relay-emulated-image-generation.ts',
    'examples/relay-emulated-code-interpreter-custom-executor.ts',
    'examples/codexnext-integration.ts',
  ];

  assert.match(readme, /^# CodexProvider/u);
  assert.match(readme, /`@codex-provider\/core` is a provider compatibility SDK/u);
  assert.match(readme, /Historical names under `@codexbridge\/codex-provider-relay`/u);
  assert.match(recipes, /^# CodexProvider Recipes/u);
  assert.match(recipes, /codex-provider-server/u);

  for (const relativePath of examples) {
    const source = readPackageFile(relativePath);
    assert.match(source, /from '@codex-provider\/core'/u, `${relativePath} should import the new package name`);
    assert.doesNotMatch(source, /@codexbridge\/codex-provider-relay/u, `${relativePath} should not import the legacy package name`);
    assert.doesNotMatch(source, /CodexProviderRelayRuntime/u, `${relativePath} should not use the legacy runtime name`);
    assert.doesNotMatch(source, /createCodexProviderRelay[A-Z]/u, `${relativePath} should not use legacy factory names`);
  }
});

test('codex provider relay release readiness docs keep unsafe tools disabled by default', () => {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const securityDoc = fs.readFileSync(path.join(packageRoot, 'docs/UNSAFE_TOOL_SECURITY.md'), 'utf8');
  const releaseDoc = fs.readFileSync(path.join(packageRoot, 'docs/RELEASE_READINESS.md'), 'utf8');
  const checklist = fs.readFileSync(path.join(packageRoot, 'docs/INDEPENDENT_PACKAGE_CHECKLIST.md'), 'utf8');

  assert.match(securityDoc, /No shell executor is bundled/u);
  assert.match(securityDoc, /No local computer controller is bundled/u);
  assert.match(securityDoc, /No code interpreter sandbox is bundled/u);
  assert.match(releaseDoc, /Keep `private: true`/u);
  assert.match(releaseDoc, /"name": "@codex-provider\/core"/u);
  assert.match(releaseDoc, /"version": "0\.1\.0-alpha\.0"/u);
  assert.match(checklist, /Live consumer validation is completed/u);
  assert.match(checklist, /package name is now `@codex-provider\/core`/u);
});
