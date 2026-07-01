import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOpenAICompatibleModelCatalog,
  buildOpenAICompatibleExternalModelCatalog,
  getOpenAICompatibleProviderPreset,
  mergeOpenAICompatibleProviderCapabilities,
  OPENAI_COMPATIBLE_PROFILE_PRESET_REGISTRATIONS,
  resolveOpenAICompatibleProviderCapabilitiesForModel,
  resolveReasoningEffortForProvider,
} from '../src/index.js';

test('capability presets are exported from the package boundary', () => {
  const preset = getOpenAICompatibleProviderPreset('minimax');
  assert.equal(preset.id, 'minimax');
  assert.equal(preset.defaultModel, 'MiniMax-M2.7');
  assert.equal(preset.capabilities?.modelCapabilities?.['MiniMax-M2.7']?.parallelToolCalls, false);
  const qwenRegistration = OPENAI_COMPATIBLE_PROFILE_PRESET_REGISTRATIONS.find((entry) => entry.presetId === 'qwen');
  assert.equal(qwenRegistration?.envPrefix, 'QWEN');
  assert.equal(qwenRegistration?.alternativeApiKeyEnv, 'DASHSCOPE_API_KEY');
});

test('external model catalogs merge model-level capabilities', () => {
  const catalog = buildOpenAICompatibleExternalModelCatalog({
    raw: {
      qwen: [{
        id: 'qwen-test',
        display_name: 'Qwen Test',
        max_completion_tokens: 4096,
        thinking: {
          min: 128,
          max: 8192,
          zero_allowed: true,
        },
      }],
    },
    defaultModel: 'qwen-test',
    displayName: 'Qwen',
    capabilities: null,
  });

  assert.equal(catalog.catalog.length, 1);
  assert.equal(catalog.catalog[0].displayName, 'Qwen Test');
  assert.deepEqual(catalog.capabilities?.modelCapabilities?.['qwen-test']?.reasoning, {
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
    defaultReasoningEffort: null,
  });
});

test('package model catalogs expose normalized capability catalog metadata', () => {
  const preset = getOpenAICompatibleProviderPreset('minimax');
  const catalog = buildOpenAICompatibleModelCatalog({
    defaultModel: preset.defaultModel,
    modelIds: [preset.defaultModel],
    displayName: preset.displayName,
    capabilities: preset.capabilities,
  });

  assert.equal(catalog.length, 1);
  assert.deepEqual(catalog[0].capabilityCatalog, {
    toolCalling: {
      supported: true,
      parallel: false,
      builtinWebSearch: false,
    },
    inputModalities: {
      image: false,
      file: false,
      pdf: false,
    },
    structuredOutput: {
      jsonSchema: true,
    },
    reasoning: {
      supported: true,
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: null,
    },
    responses: {
      compact: false,
    },
    limits: {
      maxOutputTokens: 65536,
    },
    quirks: [
      'parallel_tool_calls_filtered',
      'text_placeholder_for_unsupported_input_parts',
    ],
  });
});

test('qwen preset exposes builtin web search through chat enable_search transport', () => {
  const preset = getOpenAICompatibleProviderPreset('qwen');
  const catalog = buildOpenAICompatibleModelCatalog({
    defaultModel: preset.defaultModel,
    modelIds: [preset.defaultModel],
    displayName: preset.displayName,
    capabilities: preset.capabilities,
  });

  assert.equal(preset.capabilities?.supportsBuiltinWebSearchTool, true);
  assert.equal(preset.capabilities?.builtinWebSearchTransport, 'chat_enable_search');
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].capabilityCatalog.toolCalling.supported, true);
  assert.equal(catalog[0].capabilityCatalog.toolCalling.builtinWebSearch, true);
  assert.equal(catalog[0].capabilities?.tools, true);
  assert.equal(catalog[0].capabilities?.jsonSchema, true);
  assert.equal(catalog[0].capabilities?.webSearch, true);
});

test('external model catalogs normalize LiteLLM-style pricing and context metadata', () => {
  const catalog = buildOpenAICompatibleExternalModelCatalog({
    raw: {
      openrouter: [{
        id: 'openai/gpt-4o-mini',
        display_name: 'GPT-4o Mini',
        max_input_tokens: 128000,
        input_cost_per_token: 1.5e-7,
        output_cost_per_token: 6e-7,
        search_context_cost_per_query: {
          low: 0.001,
          high: 0.002,
        },
      }],
    },
    defaultModel: 'openai/gpt-4o-mini',
    displayName: 'OpenRouter',
    capabilities: null,
  });

  assert.equal(catalog.catalog.length, 1);
  assert.equal(catalog.catalog[0].contextWindow, 128000);
  assert.deepEqual(catalog.catalog[0].pricing, {
    inputCostPerToken: 1.5e-7,
    outputCostPerToken: 6e-7,
    searchContextCostPerQuery: {
      low: 0.001,
      high: 0.002,
    },
  });
});

test('thinking policy resolves explicit effort through package-local model info', () => {
  const capabilities = mergeOpenAICompatibleProviderCapabilities({
    thinking: {
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    },
  });

  assert.equal(resolveReasoningEffortForProvider({
    providerKind: 'openai-compatible',
    modelInfo: {
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
    },
    requestedEffort: 'high',
    capabilities,
  }), 'high');

  assert.equal(resolveReasoningEffortForProvider({
    providerKind: 'openai-compatible',
    modelInfo: {
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
    },
    requestedEffort: 'xhigh',
    capabilities,
  }), 'low');
});

test('model capability resolution applies model-specific overrides', () => {
  const capabilities = resolveOpenAICompatibleProviderCapabilitiesForModel({
    supportsTools: true,
    modelCapabilities: {
      'text-only-model': {
        tools: false,
        vision: false,
        reasoning: false,
      },
    },
  }, 'text-only-model');

  assert.equal(capabilities?.supportsTools, false);
  assert.equal(capabilities?.multimodal?.supportsImageInput, false);
  assert.equal(capabilities?.thinking?.supportsReasoningEffortSelection, false);
});
