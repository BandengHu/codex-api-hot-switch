import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexNativeApiServer } from '../../../src/providers/codex/native_api_server.js';
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

function parseSseText(text: string): Array<{ event: string; data: any }> {
  const blocks = text.split('\n\n').map((entry) => entry.trim()).filter(Boolean);
  const parsed: Array<{ event: string; data: any }> = [];
  for (const block of blocks) {
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!eventLine || !dataLine || dataLine === 'data: [DONE]') {
      continue;
    }
    parsed.push({
      event: eventLine.slice(7).trim(),
      data: JSON.parse(dataLine.slice(6)),
    });
  }
  return parsed;
}

function parseSseDataText(text: string): any[] {
  const blocks = text.split('\n\n').map((entry) => entry.trim()).filter(Boolean);
  const parsed: any[] = [];
  for (const block of blocks) {
    if (block === 'data: [DONE]') {
      continue;
    }
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) {
      continue;
    }
    parsed.push(JSON.parse(dataLine.slice(6)));
  }
  return parsed;
}

test('CodexNativeApiServer exposes /v1/models with runtime metadata', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 111,
    readAccountIdentity: () => ({
      email: 'native@example.com',
      name: 'Native Runtime',
      authMode: 'chatgpt',
      accountId: 'acc_native',
      plan: 'plus',
      authPath: '/tmp/auth.json',
    }),
  });
  let modelCalls = 0;
  const providerPlugin = {
    async listModels() {
      modelCalls += 1;
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
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/models`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(modelCalls, 1);
    assert.equal(body.object, 'list');
    assert.equal(body.data[0].id, 'gpt-5.4');
    assert.equal(body.data[0].default, true);
    assert.equal(body.meta.native_runtime.ready, true);
    assert.equal(body.meta.native_runtime.account_identity.account_id, 'acc_native');
    assert.equal(body.meta.native_runtime.provider_profile_id, 'openai-default');
    assert.equal(body.meta.continuation_registry.kind, 'in_memory');
    assert.equal(body.meta.continuation_registry.persistence, 'in_process');
    assert.equal(body.meta.continuation_registry.survives_process_restart, false);
    assert.equal(body.meta.continuation_registry.ttl_ms, 30 * 60 * 1000);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer exposes /v1/health with request-scoped readiness and route metadata', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 444,
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
    async startThread() {
      return {
        threadId: 'thread-health-1',
        cwd: '/tmp',
        title: 'health',
      };
    },
    async startTurn() {
      return {
        outputText: 'ok',
        previewText: '',
        threadId: 'thread-health-1',
        turnId: 'turn-health-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/health`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.object, 'health.check');
    assert.equal(body.status, 'ok');
    assert.equal(body.localhost_only, true);
    assert.equal(body.native_api.route_path, '/v1/health');
    assert.equal(body.native_api.request_target.provider_profile_id, 'openai-default');
    assert.equal(body.native_api.request_target.provider_kind, 'codex');
    assert.equal(body.native_api.continuation.resumed, false);
    assert.equal(body.route_capabilities.responses.create, true);
    assert.equal(body.route_capabilities.responses.continuation, true);
    assert.equal(body.route_capabilities.responses.stream, true);
    assert.equal(body.route_capabilities.responses.compact, false);
    assert.equal(body.route_capabilities.chat_completions.create, true);
    assert.equal(body.route_capabilities.chat_completions.stream, true);
    assert.equal(body.route_capabilities.chat_completions.tool_calling, false);
    assert.equal(body.continuation_registry.kind, 'in_memory');
    assert.equal(body.continuation_registry.persistence, 'in_process');
    assert.equal(body.native_runtime.ready, true);
    assert.equal(body.native_runtime.provider_profile_id, 'openai-default');
    assert.equal(body.native_runtime.account_identity.account_id, 'acc_native');
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer exposes /v1/chat/completions through the isolated native runtime', async () => {
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 707_000,
    createSessionId: () => 'session-native-chat-1',
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
    async listModels() {
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Newest coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-chat-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'compat answer',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-chat-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    defaultCwd: '/workspace/default',
    defaultLocale: 'zh-CN',
    createChatCompletionId: () => 'chatcmpl_native_1',
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Explain the test.' },
        ],
        reasoning_effort: 'high',
        metadata: {
          cwd: '/tmp/chat-project',
          locale: 'en-US',
          ticket: 'NATIVE-CHAT-1',
        },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.id, 'chatcmpl_native_1');
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.native_api.route_path, '/v1/chat/completions');
    assert.equal(body.native_api.request_target.provider_profile_id, 'openai-default');
    assert.equal(body.native_api.response_mapping.chat_completion_id, 'chatcmpl_native_1');
    assert.equal(body.native_api.response_mapping.bridge_session_id, 'session-native-chat-1');
    assert.equal(body.native_api.response_mapping.native_thread_id, 'thread-native-chat-1');
    assert.equal(body.native_api.continuation.resumed, false);
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, 'compat answer');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.native_runtime.thread_id, 'thread-native-chat-1');
    assert.equal(body.native_runtime.turn_id, 'turn-native-chat-1');
    assert.equal(body.native_runtime.bridge_session_id, 'session-native-chat-1');

    assert.equal(calls[0]?.kind, 'startThread');
    assert.equal(calls[0]?.payload.metadata.route, '/v1/chat/completions');
    assert.equal(calls[0]?.payload.metadata.source, 'codex-native-api');
    assert.equal(calls[1]?.kind, 'startTurn');
    assert.equal(calls[1]?.payload.sessionSettings.model, 'gpt-5.5');
    assert.equal(calls[1]?.payload.sessionSettings.reasoningEffort, 'high');
    assert.equal(calls[1]?.payload.sessionSettings.locale, 'en-US');
    assert.equal(calls[1]?.payload.sessionSettings.metadata.route, '/v1/chat/completions');
    assert.equal(calls[1]?.payload.sessionSettings.metadata.requestMetadata.ticket, 'NATIVE-CHAT-1');
    assert.match(calls[1]?.payload.inputText, /System instructions:\nBe terse\./);
    assert.match(calls[1]?.payload.inputText, /Conversation input:\nUSER:\nExplain the test\./);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer streams /v1/chat/completions as compatibility chunks over native progress', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 808_000,
    createSessionId: () => 'session-native-chat-stream-1',
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
    async listModels() {
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Newest coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      return {
        threadId: 'thread-native-chat-stream-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      await params.onTurnStarted?.({
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-chat-stream-1',
      });
      await params.onProgress?.({
        text: 'plan',
        delta: 'plan',
        outputKind: 'commentary',
      });
      await params.onProgress?.({
        text: 'Final ',
        delta: 'Final ',
        outputKind: 'final_answer',
      });
      await params.onProgress?.({
        text: 'Final answer.',
        delta: 'answer.',
        outputKind: 'final_answer',
      });
      return {
        outputText: 'Final answer.',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-chat-stream-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    createChatCompletionId: () => 'chatcmpl_native_stream_1',
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        stream: true,
        messages: [
          { role: 'user', content: 'Stream this response' },
        ],
      }),
    });
    const text = await response.text();
    const chunks = parseSseDataText(text);

    assert.equal(response.status, 200);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(chunks[0].object, 'chat.completion.chunk');
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.equal(chunks[1].choices[0].delta.reasoning_content, 'plan');
    assert.equal(chunks[2].choices[0].delta.content, 'Final ');
    assert.equal(chunks[3].choices[0].delta.content, 'answer.');
    assert.equal(chunks.at(-1)?.choices[0].finish_reason, 'stop');
    assert.equal(chunks.at(-1)?.native_runtime.thread_id, 'thread-native-chat-stream-1');
    assert.equal(chunks.at(-1)?.native_runtime.turn_id, 'turn-native-chat-stream-1');
    assert.equal(chunks.at(-1)?.native_runtime.bridge_session_id, 'session-native-chat-stream-1');
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer rejects unsupported chat-completions tool declarations', async () => {
  const server = new CodexNativeApiServer({
    resolveRuntimeContext: () => {
      throw new Error('resolver should not run');
    },
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{
          type: 'function',
          function: {
            name: 'lookup',
            parameters: { type: 'object' },
          },
        }],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'unsupported_chat_completions_feature');
    assert.match(body.error.message, /tool declarations/i);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer rejects chat-completions requests with n > 1', async () => {
  const server = new CodexNativeApiServer({
    resolveRuntimeContext: () => {
      throw new Error('resolver should not run');
    },
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        n: 2,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'unsupported_chat_completions_feature');
    assert.match(body.error.message, /n=1/i);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer reports degraded /v1/health when the native auth state is unavailable', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 555,
    readAccountIdentity: () => null,
  });
  const providerPlugin = {
    async listModels() {
      return [];
    },
    async startThread() {
      return {
        threadId: 'thread-health-2',
        cwd: '/tmp',
        title: 'health',
      };
    },
    async startTurn() {
      return {
        outputText: 'ok',
        previewText: '',
        threadId: 'thread-health-2',
        turnId: 'turn-health-2',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/health`);
    const body = await response.json() as any;
    assert.equal(response.status, 503);
    assert.equal(body.status, 'degraded');
    assert.equal(body.native_runtime.runtime_reachable, true);
    assert.equal(body.native_runtime.ready, false);
    assert.match(body.native_runtime.error_message, /auth state is unavailable/i);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer recovers after the native runtime becomes reachable again', async () => {
  let runtimeReachable = false;
  let startTurnCalls = 0;
  const runtime = new CodexNativeRuntime({
    now: () => 556,
    createSessionId: () => 'session-native-recover-1',
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
    async listModels() {
      if (!runtimeReachable) {
        throw new Error('app-server restarting');
      }
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
        threadId: 'thread-native-recover-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      startTurnCalls += 1;
      return {
        outputText: 'recovered answer',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-recover-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
  });
  await server.start();
  try {
    const degradedHealth = await fetch(`${server.baseUrl}/v1/health`);
    const degradedBody = await degradedHealth.json() as any;
    assert.equal(degradedHealth.status, 503);
    assert.equal(degradedBody.status, 'unavailable');
    assert.equal(degradedBody.native_runtime.runtime_reachable, false);
    assert.match(degradedBody.native_runtime.error_message, /app-server restarting/i);

    const unavailableResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Are you back yet?',
      }),
    });
    const unavailableBody = await unavailableResponse.json() as any;
    assert.equal(unavailableResponse.status, 503);
    assert.equal(unavailableBody.error.code, 'native_runtime_unavailable');
    assert.equal(startTurnCalls, 0);

    runtimeReachable = true;

    const recoveredHealth = await fetch(`${server.baseUrl}/v1/health`);
    const recoveredHealthBody = await recoveredHealth.json() as any;
    assert.equal(recoveredHealth.status, 200);
    assert.equal(recoveredHealthBody.status, 'ok');
    assert.equal(recoveredHealthBody.native_runtime.runtime_reachable, true);
    assert.equal(recoveredHealthBody.native_runtime.ready, true);

    const recoveredResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Now answer.',
      }),
    });
    const recoveredBody = await recoveredResponse.json() as any;
    assert.equal(recoveredResponse.status, 200);
    assert.equal(recoveredBody.output[0].content[0].text, 'recovered answer');
    assert.equal(recoveredBody.native_api.response_mapping.bridge_session_id, 'session-native-recover-1');
    assert.equal(startTurnCalls, 1);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer routes /v1/responses through isolated native runtime execution', async () => {
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 222000,
    createSessionId: () => 'session-native-api-1',
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
    async listModels() {
      calls.push({ kind: 'listModels', payload: null });
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Newest coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-api-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'native answer',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-api-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    defaultCwd: '/workspace/default',
    defaultLocale: 'zh-CN',
    createResponseId: () => 'resp_native_api_1',
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        instructions: 'Be terse.',
        input: [{
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Explain the test.',
          }],
        }],
        reasoning: {
          effort: 'high',
        },
        service_tier: 'flex',
        metadata: {
          cwd: '/tmp/project',
          locale: 'en-US',
          ticket: 'NATIVE-1',
          codexbridge: {
            taskClass: 'normalization',
            threadMetadata: {
              sourcePlatform: 'weixin',
              source: 'assistant-record-command-skill',
            },
            eventMetadata: {
              developerPromptContext: {
                mode: 'command-skill-parser',
                title: 'Assistant Record Command Skill',
                source: 'assistant-record-command-skill',
                command: 'todo',
                subcommand: 'natural',
                operation: 'classify_new_record',
              },
            },
          },
        },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.id, 'resp_native_api_1');
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.output[0].content[0].text, 'native answer');
    assert.equal(body.native_runtime.thread_id, 'thread-native-api-1');
    assert.equal(body.native_runtime.turn_id, 'turn-native-api-1');
    assert.equal(body.native_runtime.bridge_session_id, 'session-native-api-1');

    assert.equal(calls[0]?.kind, 'listModels');
    assert.equal(calls[1]?.kind, 'startThread');
    assert.equal(calls[1]?.payload.ephemeral, true);
    assert.equal(calls[1]?.payload.cwd, '/tmp/project');
    assert.equal(calls[1]?.payload.metadata.source, 'codex-native-api');
    assert.equal(calls[1]?.payload.metadata.sourcePlatform, 'weixin');
    assert.equal(calls[1]?.payload.metadata.sideTaskClass, 'normalization');

    assert.equal(calls[2]?.kind, 'startTurn');
    assert.equal(calls[2]?.payload.bridgeSession.id, 'session-native-api-1');
    assert.equal(calls[2]?.payload.sessionSettings.model, 'gpt-5.5');
    assert.equal(calls[2]?.payload.sessionSettings.reasoningEffort, 'high');
    assert.equal(calls[2]?.payload.sessionSettings.serviceTier, 'flex');
    assert.equal(calls[2]?.payload.sessionSettings.locale, 'en-US');
    assert.equal(calls[2]?.payload.sessionSettings.metadata.requestMetadata.ticket, 'NATIVE-1');
    assert.equal(calls[2]?.payload.event.platform, 'codex-native-api');
    assert.equal(calls[2]?.payload.event.cwd, '/tmp/project');
    assert.deepEqual(calls[2]?.payload.event.metadata?.codexbridge?.developerPromptContext, {
      mode: 'command-skill-parser',
      title: 'Assistant Record Command Skill',
      source: 'assistant-record-command-skill',
      command: 'todo',
      subcommand: 'natural',
      operation: 'classify_new_record',
    });
    assert.match(calls[2]?.payload.inputText, /System instructions:\nBe terse\./);
    assert.match(calls[2]?.payload.inputText, /Conversation input:\nUSER:\nExplain the test\./);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer continues the same isolated native thread via previous_response_id', async () => {
  let now = 500_000;
  let nextResponseId = 'resp_native_api_1';
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => now,
    createSessionId: () => 'session-native-api-1',
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
    async listModels() {
      calls.push({ kind: 'listModels', payload: null });
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Newest coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-api-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: params.event.externalScopeId === 'resp_native_api_1'
          ? 'initial answer'
          : 'follow-up answer',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: params.event.externalScopeId === 'resp_native_api_1'
          ? 'turn-native-api-1'
          : 'turn-native-api-2',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    defaultLocale: 'en-US',
    now: () => now,
    createResponseId: () => nextResponseId,
  });
  await server.start();
  try {
    const initial = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'First request',
      }),
    });
    const initialBody = await initial.json() as any;
    assert.equal(initial.status, 200);
    assert.equal(initialBody.id, 'resp_native_api_1');
    assert.equal(initialBody.native_api.route_path, '/v1/responses');
    assert.equal(initialBody.native_api.request_target.provider_profile_id, 'openai-default');
    assert.equal(initialBody.native_api.response_mapping.response_id, 'resp_native_api_1');
    assert.equal(initialBody.native_api.response_mapping.bridge_session_id, 'session-native-api-1');
    assert.equal(initialBody.native_api.response_mapping.native_thread_id, 'thread-native-api-1');
    assert.equal(initialBody.native_api.continuation.resumed, false);
    assert.equal(initialBody.output[0].content[0].text, 'initial answer');

    now = 501_000;
    nextResponseId = 'resp_native_api_2';
    const followup = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previous_response_id: 'resp_native_api_1',
        model: 'gpt-5.5',
        input: 'Second request',
      }),
    });
    const followupBody = await followup.json() as any;
    assert.equal(followup.status, 200);
    assert.equal(followupBody.id, 'resp_native_api_2');
    assert.equal(followupBody.previous_response_id, 'resp_native_api_1');
    assert.equal(followupBody.native_api.route_path, '/v1/responses');
    assert.equal(followupBody.native_api.response_mapping.response_id, 'resp_native_api_2');
    assert.equal(followupBody.native_api.response_mapping.previous_response_id, 'resp_native_api_1');
    assert.equal(followupBody.native_api.response_mapping.bridge_session_id, 'session-native-api-1');
    assert.equal(followupBody.native_api.continuation.resumed, true);
    assert.equal(followupBody.native_api.continuation.source_response_id, 'resp_native_api_1');
    assert.equal(followupBody.native_api.continuation.source_bridge_session_id, 'session-native-api-1');
    assert.equal(followupBody.native_api.continuation.source_native_thread_id, 'thread-native-api-1');
    assert.equal(followupBody.output[0].content[0].text, 'follow-up answer');
    assert.equal(followupBody.native_runtime.thread_id, 'thread-native-api-1');
    assert.equal(followupBody.native_runtime.bridge_session_id, 'session-native-api-1');

    const startThreadCalls = calls.filter((entry) => entry.kind === 'startThread');
    const startTurnCalls = calls.filter((entry) => entry.kind === 'startTurn');
    assert.equal(startThreadCalls.length, 1);
    assert.equal(startTurnCalls.length, 2);
    assert.equal(startTurnCalls[0]?.payload.bridgeSession.id, 'session-native-api-1');
    assert.equal(startTurnCalls[1]?.payload.bridgeSession.id, 'session-native-api-1');
    assert.equal(startTurnCalls[1]?.payload.bridgeSession.codexThreadId, 'thread-native-api-1');
    assert.equal(startTurnCalls[1]?.payload.sessionSettings.model, 'gpt-5.5');
    assert.equal(startTurnCalls[1]?.payload.event.externalScopeId, 'resp_native_api_2');
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer streams /v1/responses as SSE events over the native runtime progress contract', async () => {
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 606_000,
    createSessionId: () => 'session-native-api-stream-1',
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
    async listModels() {
      calls.push({ kind: 'listModels', payload: null });
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Newest coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-api-stream-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      await params.onTurnStarted?.({
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-api-stream-1',
      });
      await params.onProgress?.({
        text: 'Thinking aloud.',
        delta: 'Thinking aloud.',
        outputKind: 'commentary',
      });
      await params.onProgress?.({
        text: 'Final ',
        delta: 'Final ',
        outputKind: 'final_answer',
      });
      await params.onProgress?.({
        text: 'Final answer.',
        delta: 'answer.',
        outputKind: 'final_answer',
      });
      return {
        outputText: 'Final answer.',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-api-stream-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    defaultLocale: 'en-US',
    createResponseId: () => 'resp_native_api_stream_1',
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Stream this response',
        stream: true,
      }),
    });
    const text = await response.text();
    const events = parseSseText(text);
    const eventTypes = events.map((entry) => entry.event);
    const createdIndex = eventTypes.indexOf('response.created');
    const reasoningDeltaIndex = eventTypes.indexOf('response.reasoning_summary_text.delta');
    const textDeltaIndex = eventTypes.indexOf('response.output_text.delta');
    const completedIndex = eventTypes.lastIndexOf('response.completed');

    assert.equal(response.status, 200);
    assert.match(text, /data: \[DONE\]/);
    assert.equal(createdIndex >= 0, true);
    assert.equal(reasoningDeltaIndex > createdIndex, true);
    assert.equal(textDeltaIndex > reasoningDeltaIndex, true);
    assert.equal(completedIndex > textDeltaIndex, true);

    const completed = events.at(-1)?.data?.response;
    assert.equal(completed.id, 'resp_native_api_stream_1');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.native_api.route_path, '/v1/responses');
    assert.equal(completed.native_api.response_mapping.response_id, 'resp_native_api_stream_1');
    assert.equal(completed.native_api.response_mapping.bridge_session_id, 'session-native-api-stream-1');
    assert.equal(completed.native_api.response_mapping.native_thread_id, 'thread-native-api-stream-1');
    assert.equal(completed.native_api.continuation.resumed, false);
    assert.equal(completed.output[0].type, 'reasoning');
    assert.equal(completed.output[0].summary[0].text, 'Thinking aloud.');
    assert.equal(completed.output[1].type, 'message');
    assert.equal(completed.output[1].content[0].text, 'Final answer.');
    assert.equal(completed.native_runtime.thread_id, 'thread-native-api-stream-1');
    assert.equal(completed.native_runtime.turn_id, 'turn-native-api-stream-1');
    assert.equal(completed.native_runtime.bridge_session_id, 'session-native-api-stream-1');
    assert.equal(events.every((entry, index) => entry.data.sequence_number === index), true);

    assert.equal(calls[0]?.kind, 'listModels');
    assert.equal(calls[1]?.kind, 'startThread');
    assert.equal(calls[2]?.kind, 'startTurn');
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer rejects unknown continuation ids before runtime execution', async () => {
  let resolverCalls = 0;
  const server = new CodexNativeApiServer({
    resolveRuntimeContext: () => {
      resolverCalls += 1;
      throw new Error('resolver should not run');
    },
  });
  await server.start();
  try {
    const continuationResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'hello',
        previous_response_id: 'resp_older',
      }),
    });
    const continuationBody = await continuationResponse.json() as any;
    assert.equal(continuationResponse.status, 404);
    assert.equal(continuationBody.error.code, 'continuation_not_found');
    assert.equal(continuationBody.continuation_registry.kind, 'in_memory');
    assert.equal(continuationBody.continuation_registry.persistence, 'in_process');
    assert.equal(continuationBody.continuation_registry.survives_process_restart, false);
    assert.equal(resolverCalls, 0);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer rejects continuation when the active native account changed', async () => {
  let currentAccountId = 'acc_native_1';
  let nextResponseId = 'resp_native_api_1';
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    createSessionId: () => 'session-native-api-1',
    readAccountIdentity: () => ({
      email: 'native@example.com',
      name: 'Native Runtime',
      authMode: 'chatgpt',
      accountId: currentAccountId,
      plan: 'plus',
      authPath: '/tmp/auth.json',
    }),
  });
  const providerPlugin = {
    async listModels() {
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Newest coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-api-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'native answer',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-api-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    createResponseId: () => nextResponseId,
  });
  await server.start();
  try {
    const initial = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'First request',
      }),
    });
    assert.equal(initial.status, 200);

    currentAccountId = 'acc_native_2';
    nextResponseId = 'resp_native_api_2';
    const followup = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previous_response_id: 'resp_native_api_1',
        input: 'Second request',
      }),
    });
    const followupBody = await followup.json() as any;
    assert.equal(followup.status, 409);
    assert.equal(followupBody.error.code, 'continuation_account_mismatch');
    assert.match(followupBody.error.message, /acc_native_1/);
    assert.equal(calls.filter((entry) => entry.kind === 'startTurn').length, 1);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer enforces optional bearer auth on localhost routes', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 333,
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
    async listModels() {
      return [{
        id: 'gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        displayName: 'GPT-5.4 Mini',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    authToken: 'native-secret',
  });
  await server.start();
  try {
    const unauthorizedHealth = await fetch(`${server.baseUrl}/v1/health`);
    const unauthorizedHealthBody = await unauthorizedHealth.json() as any;
    assert.equal(unauthorizedHealth.status, 401);
    assert.equal(unauthorizedHealthBody.error.code, 'invalid_auth_token');

    const unauthorized = await fetch(`${server.baseUrl}/v1/models`);
    const unauthorizedBody = await unauthorized.json() as any;
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedBody.error.code, 'invalid_auth_token');

    const authorized = await fetch(`${server.baseUrl}/v1/models`, {
      headers: {
        Authorization: 'Bearer native-secret',
      },
    });
    const authorizedBody = await authorized.json() as any;
    assert.equal(authorized.status, 200);
    assert.equal(authorizedBody.data[0].id, 'gpt-5.4-mini');
  } finally {
    await server.stop();
  }
});
