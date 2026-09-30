import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OpenAICompatibleProviderPlugin,
  buildOpenAICompatibleCodexCliArgs,
} from '../../../src/providers/openai_compatible/plugin.js';

function makeProfile(overrides = {}) {
  return {
    id: 'compat',
    providerKind: 'openai-compatible',
    displayName: 'OpenAI Compatible',
    config: {
      cliBin: 'codex',
      apiKeyEnv: 'OPENAI_COMPAT_API_KEY',
      baseUrl: 'https://example.com/v1',
      defaultModel: 'example-model',
      modelCatalog: [{
        id: 'example-model',
        model: 'example-model',
        displayName: 'Example Model',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['low', 'medium'],
        defaultReasoningEffort: 'medium',
      }],
      ...overrides,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test('buildOpenAICompatibleCodexCliArgs configures Codex app-server to use the local Responses adapter', () => {
  const args = buildOpenAICompatibleCodexCliArgs({
    providerLabel: 'example_provider',
    providerName: 'Example Provider',
    adapterBaseUrl: 'http://127.0.0.1:4321/v1',
    apiKeyEnv: 'EXAMPLE_API_KEY',
    defaultModel: 'example-model',
  });

  assert.deepEqual(args.slice(0, 4), ['-c', 'model="example-model"', '-c', 'model_provider="example_provider"']);
  assert.equal(args.includes('model_providers.example_provider.base_url="http://127.0.0.1:4321/v1"'), true);
  assert.equal(args.includes('model_providers.example_provider.wire_api="responses"'), true);
  assert.equal(args.includes('model_providers.example_provider.requires_openai_auth=false'), true);
});

test('OpenAICompatibleProviderPlugin can delegate normal provider operations through a Codex-like client', async () => {
  const calls: string[] = [];
  const plugin = new OpenAICompatibleProviderPlugin({
    defaults: {
      kind: 'example-provider',
      displayName: 'Example Provider',
      apiKeyEnv: 'EXAMPLE_API_KEY',
      baseUrl: 'https://example.com/v1',
      defaultModel: 'example-model',
      providerLabel: 'example_provider',
      modelIds: ['example-model'],
      ownedBy: 'example',
      upstreamChatCompletionsPath: '/chat/completions',
    },
    clientFactory: () => ({
      async start() {
        calls.push('start');
      },
      isConnected() {
        return true;
      },
      async listModels() {
        return [{
          id: 'example-model',
          model: 'example-model',
          displayName: 'Example Model',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['low', 'medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
      async startThread({ cwd, title, model }: any) {
        calls.push(`startThread:${model}`);
        return {
          threadId: 'thread-1',
          cwd,
          title,
        };
      },
      async stop() {},
    }),
  });

  const result = await plugin.startThread({
    providerProfile: makeProfile(),
    cwd: '/tmp/work',
    title: 'Example',
  });

  assert.equal(plugin.kind, 'example-provider');
  assert.deepEqual(calls, ['start', 'startThread:example-model']);
  assert.equal(result.threadId, 'thread-1');
});

test('OpenAICompatibleProviderPlugin resolves reasoning effort from explicit provider capabilities', () => {
  const plugin = new OpenAICompatibleProviderPlugin({
    defaults: {
      kind: 'example-provider',
      displayName: 'Example Provider',
      apiKeyEnv: 'EXAMPLE_API_KEY',
      baseUrl: 'https://example.com/v1',
      defaultModel: 'example-model',
      providerLabel: 'example_provider',
      modelIds: ['example-model'],
      ownedBy: 'example',
      upstreamChatCompletionsPath: '/chat/completions',
      capabilities: {
        thinking: {
          supportsReasoningEffortSelection: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          stripFields: ['reasoning_effort'],
          mode: 'disabled',
          disabledThinkingValue: { type: 'disabled' },
        },
      },
    },
  });

  const effort = plugin.resolveReasoningEffort(makeProfile({
    capabilities: {
      thinking: {
        supportsReasoningEffortSelection: false,
      },
    },
  }) as any, {
    id: 'example-model',
    model: 'example-model',
    displayName: 'Example Model',
    description: '',
    isDefault: true,
    supportedReasoningEfforts: ['low', 'medium'],
    defaultReasoningEffort: 'medium',
  }, 'high');

  assert.equal(effort, null);
});

test('OpenAICompatibleProviderPlugin lists live upstream models instead of stale static aliases', async () => {
  const plugin = new OpenAICompatibleProviderPlugin({
    env: {
      QWEN_API_KEY: 'qwen-key',
    },
    fetchImpl: (async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        {
          id: 'qwen-plus',
          display_name: 'Qwen Plus',
        },
        {
          id: 'qwen3-coder-plus',
          display_name: 'Qwen3 Coder Plus',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
    defaults: {
      kind: 'qwen',
      displayName: 'Qwen',
      apiKeyEnv: 'QWEN_API_KEY',
      baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-plus',
      providerLabel: 'qwen',
      modelIds: ['qwen-plus'],
      ownedBy: 'qwen',
    },
  });

  const models = await plugin.listModels({
    providerProfile: makeProfile({
      apiKeyEnv: 'QWEN_API_KEY',
      baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-plus',
      modelCatalog: [{
        id: 'coder-model',
        model: 'coder-model',
        displayName: 'Qwen 3.6 Plus',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      }],
    }),
  });

  assert.deepEqual(
    models.map((entry) => entry.id),
    ['qwen-plus', 'qwen3-coder-plus'],
  );
  assert.equal(models[0]?.displayName, 'Qwen Plus');
  assert.equal(models[0]?.isDefault, true);
});

test('OpenAICompatibleProviderPlugin falls back to a valid live model when session settings contain a stale model id', async () => {
  const seenModels: string[] = [];
  const plugin = new OpenAICompatibleProviderPlugin({
    env: {
      QWEN_API_KEY: 'qwen-key',
    },
    fetchImpl: (async () => new Response(JSON.stringify({
      object: 'list',
      data: [
        {
          id: 'qwen-plus',
          display_name: 'Qwen Plus',
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
    defaults: {
      kind: 'qwen',
      displayName: 'Qwen',
      apiKeyEnv: 'QWEN_API_KEY',
      baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-plus',
      providerLabel: 'qwen',
      modelIds: ['qwen-plus'],
      ownedBy: 'qwen',
    },
    clientFactory: () => ({
      async start() {},
      isConnected() {
        return true;
      },
      async startTurn(params: any) {
        seenModels.push(String(params.model ?? ''));
        return {
          outputText: 'ok',
          outputState: 'complete',
          previewText: 'ok',
          finalSource: 'thread_items',
          status: 'completed',
          turnId: 'turn-1',
          threadId: params.threadId,
          title: 'Qwen thread',
        };
      },
      async listModels() {
        return [];
      },
      async stop() {},
    }),
  });

  await plugin.startTurn({
    providerProfile: makeProfile({
      providerKind: 'qwen',
      displayName: 'Qwen',
      apiKeyEnv: 'QWEN_API_KEY',
      baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-plus',
    }) as any,
    bridgeSession: {
      id: 'bridge-1',
      providerProfileId: 'compat',
      providerKind: 'qwen',
      codexThreadId: 'thread-1',
      cwd: null,
      title: 'Qwen thread',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any,
    sessionSettings: {
      model: 'coder-model',
    } as any,
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_test',
      text: 'hello',
    } as any,
    inputText: 'hello',
  });

  assert.deepEqual(seenModels, ['qwen-plus']);
});
