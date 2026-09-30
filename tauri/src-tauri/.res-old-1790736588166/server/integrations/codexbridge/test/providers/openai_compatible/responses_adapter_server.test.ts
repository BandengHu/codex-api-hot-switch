import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAICompatibleResponsesAdapterServer } from '../../../src/providers/openai_compatible/responses_adapter_server.js';

test('OpenAICompatibleResponsesAdapterServer synthesizes compact responses when upstream compact is unsupported', async () => {
  let fetchCalls = 0;
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response('{}');
    }) as typeof fetch,
    providerCapabilities: {
      supportsResponsesCompact: false,
      usage: {
        estimateWhenMissing: true,
      },
    },
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        input: 'hello',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(fetchCalls, 0);
    assert.equal(body.object, 'response.compaction');
    assert.equal(body.output[0].content[0].text, 'hello');
  } finally {
    await server.stop();
  }
});

test('OpenAICompatibleResponsesAdapterServer passes compact requests through when provider supports compact', async () => {
  let capturedUrl = '';
  let capturedBody: any = null;
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    upstreamBaseUrl: 'https://provider.example/v1',
    fetchImpl: (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({
        id: 'resp_1',
        object: 'response.compaction',
        created_at: 1234,
        output: [],
        usage: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
    providerCapabilities: {
      supportsResponsesCompact: true,
      upstreamResponsesCompactPath: '/responses/compact',
    },
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        input: 'hello',
        stream: false,
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://provider.example/v1/responses/compact');
    assert.equal(capturedBody.stream, undefined);
    assert.equal(body.object, 'response.compaction');
  } finally {
    await server.stop();
  }
});

test('OpenAICompatibleResponsesAdapterServer exposes model capability metadata in /models', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    models: [{
      id: 'example-model',
      displayName: 'Example Model',
      capabilities: {
        tools: true,
        vision: false,
        maxOutputTokens: 4096,
      },
    }],
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/models`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.data[0].id, 'example-model');
    assert.equal(body.data[0].displayName, 'Example Model');
    assert.equal(body.data[0].display_name, 'Example Model');
    assert.deepEqual(body.data[0].capabilities, {
      tools: true,
      vision: false,
      maxOutputTokens: 4096,
    });
  } finally {
    await server.stop();
  }
});

test('OpenAICompatibleResponsesAdapterServer proxies responses requests directly when provider exposes upstream responses path', async () => {
  let capturedUrl = '';
  let capturedBody: any = null;
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    upstreamBaseUrl: 'https://dashscope.example/compatible-mode/v1',
    fetchImpl: (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({
        id: 'resp_1',
        object: 'response',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: '实时搜索结果',
          }],
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
    providerCapabilities: {
      supportsBuiltinWebSearchTool: true,
      upstreamResponsesPath: '/responses',
    },
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen-plus',
        input: '联网搜索哔哩哔哩开源工具',
        tools: [{
          type: 'web_search',
        }],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://dashscope.example/compatible-mode/v1/responses');
    assert.equal(capturedBody.model, 'qwen-plus');
    assert.deepEqual(capturedBody.tools, [{ type: 'web_search' }]);
    assert.equal(body.output[0].content[0].text, '实时搜索结果');
  } finally {
    await server.stop();
  }
});

test('OpenAICompatibleResponsesAdapterServer retries configured transient upstream statuses', async () => {
  let calls = 0;
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    upstreamBaseUrl: 'https://provider.example/v1',
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          error: {
            message: 'temporarily overloaded',
          },
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl_1',
        created: 1234,
        model: 'example-model',
        choices: [{
          message: {
            content: 'OK',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
    providerCapabilities: {
      retry: {
        maxAttempts: 2,
        retryStatuses: [503],
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    },
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        input: 'hello',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(body.output[0].content[0].text, 'OK');
  } finally {
    await server.stop();
  }
});

test('OpenAICompatibleResponsesAdapterServer maps upstream HTTP status to OpenAI-style error codes', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    upstreamBaseUrl: 'https://provider.example/v1',
    fetchImpl: (async () => new Response(JSON.stringify({
      error: {
        message: 'slow down',
        type: 'rate_limit_error',
      },
    }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        input: 'hello',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 429);
    assert.equal(body.error.message, 'slow down');
    assert.equal(body.error.type, 'rate_limit_error');
    assert.equal(body.error.code, 'rate_limit_exceeded');
  } finally {
    await server.stop();
  }
});
