import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexNativeApiService } from '../../../src/providers/codex/native_api_service.js';
import { CodexNativeRuntime } from '../../../src/providers/codex/native_runtime.js';

function makeProfile(overrides = {}) {
  return {
    id: 'openai-default',
    providerKind: 'openai-native',
    displayName: 'Codex OpenAI',
    config: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeProviderProfiles(profiles: any[]) {
  return {
    get(id: string) {
      return profiles.find((profile) => profile.id === id) ?? null;
    },
    list() {
      return [...profiles];
    },
  };
}

test('CodexNativeApiService starts a standalone localhost server against the selected provider profile', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 111,
    readAccountIdentity: () => ({
      email: 'native@example.com',
      name: 'Native Runtime',
      authMode: 'chatgpt',
      accountId: 'acc_native',
      plan: 'plus',
      authPath: '/tmp/native-api-auth.json',
    }),
  });
  const service = new CodexNativeApiService({
    runtime,
    providerProfiles: makeProviderProfiles([makeProfile()]) as any,
    providerRegistry: {
      getProvider() {
        return {
          async listModels() {
            return [{
              id: 'gpt-5.4',
              model: 'gpt-5.4',
              displayName: 'GPT-5.4',
              description: 'Frontier coding model.',
              isDefault: true,
              supportedReasoningEfforts: ['medium', 'high'],
              defaultReasoningEffort: 'medium',
            }];
          },
        } as any;
      },
    } as any,
    authPath: '/tmp/native-api-auth.json',
  });

  assert.deepEqual(service.describeBinding(), {
    providerProfileId: 'openai-default',
    providerKind: 'openai-native',
    providerDisplayName: 'Codex OpenAI',
    authPath: '/tmp/native-api-auth.json',
  });

  await service.start();
  try {
    const response = await fetch(`${service.baseUrl}/v1/models`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.meta.native_runtime.provider_profile_id, 'openai-default');
    assert.equal(body.meta.native_runtime.account_identity.account_id, 'acc_native');
  } finally {
    await service.stop();
  }
});

test('CodexNativeApiService rejects unknown provider profile overrides before startup', async () => {
  const service = new CodexNativeApiService({
    providerProfiles: makeProviderProfiles([makeProfile()]) as any,
    providerRegistry: {
      getProvider() {
        return {} as any;
      },
    } as any,
    providerProfileId: 'missing-profile',
  });

  await assert.rejects(
    () => service.start(),
    /Unknown Codex native API provider profile: missing-profile/,
  );
});

test('CodexNativeApiService continuations stay in-process and do not survive a service restart', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 222,
    createSessionId: () => 'session-native-api-1',
    readAccountIdentity: () => ({
      email: 'native@example.com',
      name: 'Native Runtime',
      authMode: 'chatgpt',
      accountId: 'acc_native',
      plan: 'plus',
      authPath: '/tmp/native-api-auth.json',
    }),
  });
  let startTurnCalls = 0;
  const providerPlugin = {
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: 'Frontier coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      return {
        threadId: 'thread-native-api-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      startTurnCalls += 1;
      return {
        outputText: `reply-${startTurnCalls}`,
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: `turn-native-api-${startTurnCalls}`,
      };
    },
  } as any;
  const providerRegistry = {
    getProvider() {
      return providerPlugin;
    },
  } as any;
  const providerProfiles = makeProviderProfiles([makeProfile()]) as any;
  const service = new CodexNativeApiService({
    runtime,
    providerProfiles,
    providerRegistry,
    createResponseId: () => 'resp_native_api_1',
  });

  await service.start();
  try {
    const initial = await fetch(`${service.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'First request',
      }),
    });
    const initialBody = await initial.json() as any;
    assert.equal(initial.status, 200);
    assert.equal(initialBody.id, 'resp_native_api_1');
  } finally {
    await service.stop();
  }

  const restartedService = new CodexNativeApiService({
    runtime,
    providerProfiles,
    providerRegistry,
  });

  await restartedService.start();
  try {
    const followup = await fetch(`${restartedService.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previous_response_id: 'resp_native_api_1',
        input: 'Second request',
      }),
    });
    const followupBody = await followup.json() as any;
    assert.equal(followup.status, 404);
    assert.equal(followupBody.error.code, 'continuation_not_found');
    assert.equal(followupBody.continuation_registry.kind, 'in_memory');
    assert.equal(followupBody.continuation_registry.persistence, 'in_process');
    assert.equal(followupBody.continuation_registry.survives_process_restart, false);
    assert.equal(startTurnCalls, 1);
  } finally {
    await restartedService.stop();
  }
});
