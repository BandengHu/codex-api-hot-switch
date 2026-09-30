import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS,
  createCodexProviderRelayHostedToolExecutorRegistry,
  isCodexProviderRelayRelayEmulatedBuiltinToolType,
  normalizeCodexProviderRelayBuiltinToolName,
  normalizeCodexProviderRelayHostedTools,
} from '../src/index.js';

test('builtin tool registry exposes canonical tool definitions', () => {
  assert.equal(CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS.web_search.name, 'web_search');
  assert.equal(CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS.file_search.relayEmulatedSupported, true);
  assert.equal(CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS.tool_search.relayEmulatedSupported, true);
  assert.equal(CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS.image_generation.relayEmulatedSupported, true);
  assert.equal(CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS.code_interpreter.relayEmulatedSupported, true);
  assert.equal(CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS.code_interpreter.unsafeByDefault, true);
  assert.equal(CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS.computer.relayEmulatedSupported, true);
  assert.equal(CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS.computer.unsafeByDefault, true);
  assert.equal(CODEX_PROVIDER_RELAY_BUILTIN_TOOL_DEFINITIONS.apply_patch.status, 'supported');
});

test('builtin tool aliases normalize without enabling unsupported relay tools', () => {
  assert.equal(normalizeCodexProviderRelayBuiltinToolName('web_search_preview'), 'web_search');
  assert.equal(normalizeCodexProviderRelayBuiltinToolName('web_search_preview_2025_03_11'), 'web_search');
  assert.equal(normalizeCodexProviderRelayBuiltinToolName('tool_search'), 'tool_search');
  assert.equal(normalizeCodexProviderRelayBuiltinToolName('image_generation'), 'image_generation');
  assert.equal(normalizeCodexProviderRelayBuiltinToolName('code_interpreter'), 'code_interpreter');
  assert.equal(normalizeCodexProviderRelayBuiltinToolName('computer_use'), 'computer');
  assert.equal(normalizeCodexProviderRelayBuiltinToolName('computer_use_preview'), 'computer');
  assert.equal(normalizeCodexProviderRelayBuiltinToolName('not_a_builtin_tool'), null);
  assert.equal(isCodexProviderRelayRelayEmulatedBuiltinToolType('web_search_preview'), true);
  assert.equal(isCodexProviderRelayRelayEmulatedBuiltinToolType('file_search'), true);
  assert.equal(isCodexProviderRelayRelayEmulatedBuiltinToolType('tool_search'), true);
  assert.equal(isCodexProviderRelayRelayEmulatedBuiltinToolType('image_generation'), true);
  assert.equal(isCodexProviderRelayRelayEmulatedBuiltinToolType('code_interpreter'), true);
  assert.equal(isCodexProviderRelayRelayEmulatedBuiltinToolType('computer_use_preview'), true);
});

test('hosted tool declarations normalize legacy aliases to canonical names', () => {
  const hostedTools = normalizeCodexProviderRelayHostedTools([
    {
      name: 'web_search_preview',
      mode: 'relay-emulated',
    },
    {
      name: 'computer_use_preview',
      mode: 'provider-native',
    },
  ]);

  assert.deepEqual(hostedTools, [
    {
      name: 'web_search',
      mode: 'relay-emulated',
      providerToolName: null,
      relayToolName: 'web_search',
      description: null,
    },
    {
      name: 'computer',
      mode: 'provider-native',
      providerToolName: 'computer',
      relayToolName: null,
      description: null,
    },
  ]);
  assert.throws(() => normalizeCodexProviderRelayHostedTools([{
    name: 'unknown_builtin',
    mode: 'relay-emulated',
  } as any]), /Unsupported hosted tool name/u);
});

test('hosted tool executor registry resolves legacy aliases to canonical names', async () => {
  const registry = createCodexProviderRelayHostedToolExecutorRegistry({
    computer_use_preview: () => ({ content: 'ok' }),
  });

  assert.equal(registry.has('computer'), true);
  assert.equal(registry.has('computer_use'), true);
  assert.deepEqual(await registry.execute({
    toolName: 'computer',
    relayToolName: 'relay_computer',
    callId: 'call_computer_1',
    arguments: {},
    rawArguments: '{}',
    model: null,
    providerKind: null,
    providerName: null,
  }), {
    content: 'ok',
    metadata: null,
  });
});
