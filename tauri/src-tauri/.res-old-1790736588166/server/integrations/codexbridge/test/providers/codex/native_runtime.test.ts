import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexNativeRuntime } from '../../../src/providers/codex/native_runtime.js';

function makeProfile(overrides = {}) {
  return {
    id: 'openai-default',
    providerKind: 'codex',
    displayName: 'Codex OpenAI',
    config: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

test('CodexNativeRuntime runIsolatedTurn reuses one ephemeral substrate with read-only defaults', async () => {
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 1234567890,
    createSessionId: () => 'session-native-1',
  });
  const providerPlugin = {
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-1',
        cwd: '/tmp/runtime',
        title: 'Native Runtime Skill',
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'normalized',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
      };
    },
  } as any;

  const execution = await runtime.runIsolatedTurn({
    providerProfile: makeProfile(),
    providerPlugin,
    cwd: '/tmp/original',
    title: 'Native Runtime Skill',
    metadata: {
      source: 'unit-test',
    },
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    serviceTier: 'flex',
    prepareTurn: (session) => ({
      inputText: `cwd=${session.cwd}`,
      locale: 'zh-CN',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      event: {
        platform: 'weixin',
        externalScopeId: 'wx-native-runtime-1',
        text: `cwd=${session.cwd}`,
        cwd: session.cwd,
        locale: 'zh-CN',
        attachments: [],
      },
    }),
  });

  assert.equal(execution.session.id, 'session-native-1');
  assert.equal(execution.session.codexThreadId, 'thread-native-1');
  assert.equal(execution.session.cwd, '/tmp/runtime');
  assert.equal(execution.result.outputText, 'normalized');
  assert.equal(calls[0]?.kind, 'startThread');
  assert.equal(calls[0]?.payload.ephemeral, true);
  assert.equal(calls[0]?.payload.metadata.source, 'unit-test');
  assert.equal(calls[1]?.kind, 'startTurn');
  assert.equal(calls[1]?.payload.bridgeSession.id, 'session-native-1');
  assert.equal(calls[1]?.payload.sessionSettings.model, 'gpt-5.5');
  assert.equal(calls[1]?.payload.sessionSettings.reasoningEffort, 'high');
  assert.equal(calls[1]?.payload.sessionSettings.serviceTier, 'flex');
  assert.equal(calls[1]?.payload.sessionSettings.accessPreset, 'read-only');
  assert.equal(calls[1]?.payload.sessionSettings.approvalPolicy, 'never');
  assert.equal(calls[1]?.payload.sessionSettings.sandboxMode, 'read-only');
  assert.equal(calls[1]?.payload.sessionSettings.locale, 'zh-CN');
  assert.equal(calls[1]?.payload.event.cwd, '/tmp/runtime');
  assert.equal(calls[1]?.payload.inputText, 'cwd=/tmp/runtime');
});

test('CodexNativeRuntime continueIsolatedTurn reuses an existing isolated bridge session', async () => {
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 9876543210,
  });
  const providerPlugin = {
    async startThread() {
      calls.push({ kind: 'startThread', payload: null });
      throw new Error('should not create a new thread');
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'continued',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-continued-1',
      };
    },
  } as any;

  const execution = await runtime.continueIsolatedTurn({
    providerProfile: makeProfile(),
    providerPlugin,
    bridgeSession: {
      id: 'session-native-existing',
      providerProfileId: 'openai-default',
      codexThreadId: 'thread-native-existing',
      cwd: '/tmp/existing-session',
      title: 'Existing Native Session',
      createdAt: 10,
      updatedAt: 20,
    },
    model: 'gpt-5.5',
    reasoningEffort: 'medium',
    serviceTier: 'default',
    prepareTurn: (session) => ({
      inputText: `continue ${session.codexThreadId}`,
      locale: 'en-US',
      event: {
        platform: 'codex-native-api',
        externalScopeId: 'resp_existing',
        text: `continue ${session.codexThreadId}`,
        cwd: session.cwd,
        locale: 'en-US',
        attachments: [],
      },
    }),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, 'startTurn');
  assert.equal(calls[0]?.payload.bridgeSession.id, 'session-native-existing');
  assert.equal(calls[0]?.payload.bridgeSession.codexThreadId, 'thread-native-existing');
  assert.equal(calls[0]?.payload.sessionSettings.model, 'gpt-5.5');
  assert.equal(calls[0]?.payload.inputText, 'continue thread-native-existing');
  assert.equal(execution.session.id, 'session-native-existing');
  assert.equal(execution.session.updatedAt, 9876543210);
  assert.equal(execution.result.turnId, 'turn-native-continued-1');
});

test('CodexNativeRuntime exposes turn-start and progress hooks for server-facing streaming', async () => {
  const progressUpdates: Array<{ text: string; delta: string; outputKind: string }> = [];
  const turnStarted: Array<{ threadId: string; turnId: string | null; bridgeSessionId: string }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 654321,
    createSessionId: () => 'session-native-stream-1',
  });
  const providerPlugin = {
    async startThread() {
      return {
        threadId: 'thread-native-stream-1',
        cwd: '/tmp/native-stream',
        title: 'Native Stream',
      };
    },
    async startTurn(params: any) {
      await params.onTurnStarted?.({
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-stream-1',
      });
      await params.onProgress?.({
        text: 'Thinking aloud.',
        delta: 'Thinking aloud.',
        outputKind: 'commentary',
      });
      await params.onProgress?.({
        text: 'Final answer.',
        delta: 'Final answer.',
        outputKind: 'final_answer',
      });
      return {
        outputText: 'Final answer.',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-stream-1',
      };
    },
  } as any;

  await runtime.runIsolatedTurn({
    providerProfile: makeProfile(),
    providerPlugin,
    cwd: '/tmp/native-stream',
    title: 'Native Stream',
    prepareTurn: (session) => ({
      inputText: 'stream this turn',
      event: {
        platform: 'codex-native-api',
        externalScopeId: 'resp_stream_native_1',
        text: 'stream this turn',
        cwd: session.cwd,
        locale: 'en-US',
        attachments: [],
      },
    }),
    onTurnStarted: (meta) => {
      turnStarted.push(meta);
    },
    onProgress: (progress) => {
      progressUpdates.push(progress);
    },
  });

  assert.deepEqual(turnStarted, [{
    threadId: 'thread-native-stream-1',
    turnId: 'turn-native-stream-1',
    bridgeSessionId: 'session-native-stream-1',
  }]);
  assert.deepEqual(progressUpdates, [{
    text: 'Thinking aloud.',
    delta: 'Thinking aloud.',
    outputKind: 'commentary',
  }, {
    text: 'Final answer.',
    delta: 'Final answer.',
    outputKind: 'final_answer',
  }]);
});

test('CodexNativeRuntime checkReadiness reports account identity and model probe status', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 222,
    readAccountIdentity: () => ({
      email: 'native@example.com',
      name: 'Native Runtime',
      authMode: 'chatgpt',
      accountId: 'acc_native',
      plan: 'plus',
      authPath: '/tmp/auth.json',
    }),
  });
  const providerPlugin = {
    async startThread() {
      return null;
    },
    async startTurn() {
      return null;
    },
    async listModels() {
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  } as any;

  const readiness = await runtime.checkReadiness({
    providerProfile: makeProfile(),
    providerPlugin,
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.runtimeReachable, true);
  assert.equal(readiness.modelCount, 1);
  assert.equal(readiness.accountIdentity?.accountId, 'acc_native');
  assert.equal(readiness.errorMessage, null);
  assert.equal(readiness.checkedAt, 222);
});

test('CodexNativeRuntime checkReadiness surfaces readiness probe failures', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 333,
    readAccountIdentity: () => null,
  });
  const providerPlugin = {
    async startThread() {
      return null;
    },
    async startTurn() {
      return null;
    },
    async listModels() {
      throw new Error('probe failed');
    },
  } as any;

  const readiness = await runtime.checkReadiness({
    providerProfile: makeProfile(),
    providerPlugin,
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.runtimeReachable, false);
  assert.equal(readiness.modelCount, null);
  assert.equal(readiness.accountIdentity, null);
  assert.equal(readiness.errorMessage, 'probe failed');
});

test('CodexNativeRuntime reconnectProfile refreshes the provider and returns a readiness snapshot', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 444,
    readAccountIdentity: () => ({
      email: 'fallback@example.com',
      name: 'Fallback Identity',
      authMode: 'chatgpt',
      accountId: 'acc_fallback',
      plan: 'plus',
      authPath: '/tmp/auth.json',
    }),
  });
  let reconnectCalls = 0;
  const providerPlugin = {
    async startThread() {
      return null;
    },
    async startTurn() {
      return null;
    },
    async reconnectProfile() {
      reconnectCalls += 1;
      return {
        connected: true,
        accountIdentity: {
          email: 'runtime@example.com',
          name: null,
          authMode: 'chatgpt',
          accountId: 'acc_runtime',
        },
      };
    },
    async listModels() {
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  } as any;

  const refreshed = await runtime.reconnectProfile({
    providerProfile: makeProfile(),
    providerPlugin,
  });

  assert.equal(reconnectCalls, 1);
  assert.equal(refreshed?.connected, true);
  assert.equal(refreshed?.accountIdentity?.email, 'runtime@example.com');
  assert.equal(refreshed?.readiness.ready, true);
  assert.equal(refreshed?.readiness.modelCount, 1);
});

test('CodexNativeRuntime reconnectProfiles aggregates errors and skips unsupported providers', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 555,
    readAccountIdentity: () => ({
      email: 'native@example.com',
      name: 'Native Runtime',
      authMode: 'chatgpt',
      accountId: 'acc_native',
      plan: 'plus',
      authPath: '/tmp/auth.json',
    }),
  });
  const supportedPlugin = {
    async startThread() {
      return null;
    },
    async startTurn() {
      return null;
    },
    async reconnectProfile() {
      return { connected: true };
    },
    async listModels() {
      return [];
    },
  } as any;
  const failingPlugin = {
    async startThread() {
      return null;
    },
    async startTurn() {
      return null;
    },
    async reconnectProfile() {
      throw new Error('reconnect failed');
    },
    async listModels() {
      return [];
    },
  } as any;

  const summary = await runtime.reconnectProfiles({
    providerProfiles: [
      makeProfile({ id: 'native-1', providerKind: 'openai-native' }),
      makeProfile({ id: 'native-2', providerKind: 'openai-compatible' }),
      makeProfile({ id: 'native-3', providerKind: 'openai-native' }),
    ],
    resolveProviderPlugin: (providerKind) => {
      if (providerKind === 'openai-native') {
        return supportedPlugin;
      }
      if (providerKind === 'openai-compatible') {
        return {
          startThread: supportedPlugin.startThread,
          startTurn: supportedPlugin.startTurn,
          listModels: supportedPlugin.listModels,
        } as any;
      }
      return failingPlugin;
    },
  });

  assert.equal(summary.refreshedCount, 2);
  assert.equal(summary.errors.length, 0);
  assert.equal(summary.results.length, 2);
  assert.equal(summary.results[0]?.providerProfileId, 'native-1');
  assert.equal(summary.results[1]?.providerProfileId, 'native-3');

  const failingSummary = await runtime.reconnectProfiles({
    providerProfiles: [
      makeProfile({ id: 'native-4', providerKind: 'custom-native' }),
    ],
    resolveProviderPlugin: () => failingPlugin,
  });

  assert.equal(failingSummary.refreshedCount, 0);
  assert.deepEqual(failingSummary.errors, ['reconnect failed']);
  assert.equal(failingSummary.results.length, 0);
});
