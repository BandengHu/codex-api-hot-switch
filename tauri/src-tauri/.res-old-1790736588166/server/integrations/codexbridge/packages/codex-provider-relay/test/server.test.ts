import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOpenAICompatibleChatCompletionsUrl,
  buildOpenAICompatibleModelsUrl,
  createCodexProviderRelayCodeInterpreterExecutor,
  createCodexProviderRelayComputerExecutor,
  isOpenAICompatibleChatCompletionsProxyPath,
  isOpenAICompatibleModelsProxyPath,
  isOpenAICompatibleResponsesProxyPath,
  OpenAICompatibleResponsesAdapterServer,
  reserveLocalPort,
} from '../src/index.js';

function createEventStreamResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}

function createRawEventStreamResponse(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}

function parseSseText(text: string): Array<{ event: string; data: any }> {
  const blocks = text.split('\n\n').map((entry) => entry.trim()).filter(Boolean);
  const parsed: Array<{ event: string; data: any }> = [];
  for (const block of blocks) {
    const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!eventLine || !dataLine) {
      continue;
    }
    parsed.push({
      event: eventLine.slice(7).trim(),
      data: JSON.parse(dataLine.slice(6)),
    });
  }
  return parsed;
}

test('adapter server is available from the package boundary', async () => {
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

test('adapter server URL and route helpers match Codex++ proxy aliases', () => {
  assert.equal(
    buildOpenAICompatibleChatCompletionsUrl('https://api.example.test'),
    'https://api.example.test/v1/chat/completions',
  );
  assert.equal(
    buildOpenAICompatibleChatCompletionsUrl('https://api.example.test/v1'),
    'https://api.example.test/v1/chat/completions',
  );
  assert.equal(
    buildOpenAICompatibleChatCompletionsUrl('https://api.example.test/openai'),
    'https://api.example.test/openai/chat/completions',
  );
  assert.equal(
    buildOpenAICompatibleChatCompletionsUrl('https://api.example.test/v1/chat/completions'),
    'https://api.example.test/v1/chat/completions',
  );
  assert.equal(
    buildOpenAICompatibleChatCompletionsUrl('https://api.example.test/v2'),
    'https://api.example.test/v2/chat/completions',
  );
  assert.equal(
    buildOpenAICompatibleChatCompletionsUrl('https://api.example.test/v1beta'),
    'https://api.example.test/v1beta/chat/completions',
  );
  assert.equal(
    buildOpenAICompatibleChatCompletionsUrl('https://api.example.test/openai#'),
    'https://api.example.test/openai/chat/completions',
  );
  assert.equal(
    buildOpenAICompatibleModelsUrl('https://api.example.test/v1/chat/completions'),
    'https://api.example.test/v1/models',
  );
  assert.equal(
    buildOpenAICompatibleModelsUrl('https://api.example.test/openai#'),
    'https://api.example.test/openai/models',
  );

  for (const path of [
    '/responses',
    '/v1/responses',
    '/v1/v1/responses',
    '/codex/v1/responses',
    '/responses/compact',
    '/v1/responses/compact',
    '/v1/v1/responses/compact',
    '/codex/v1/responses/compact',
  ]) {
    assert.equal(isOpenAICompatibleResponsesProxyPath(path), true, path);
  }
  for (const path of [
    '/chat/completions',
    '/v1/chat/completions',
    '/v1/v1/chat/completions',
    '/codex/v1/chat/completions',
  ]) {
    assert.equal(isOpenAICompatibleChatCompletionsProxyPath(path), true, path);
  }
  for (const path of ['/models', '/v1/models', '/v1/v1/models', '/codex/v1/models', '/v1/models?limit=10']) {
    assert.equal(isOpenAICompatibleModelsProxyPath(path), true, path);
  }
  assert.equal(isOpenAICompatibleModelsProxyPath('/v1/responses'), false);
});

test('adapter server trace sink captures request translation and non-streaming response mapping', async () => {
  const events: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    traceSink: (event) => {
      events.push(JSON.parse(JSON.stringify(event)));
    },
    fetchImpl: (async () => new Response(JSON.stringify({
      id: 'chatcmpl_trace_nonstream',
      created: 1_700_000_210,
      model: 'trace-model',
      choices: [{
        message: {
          content: 'trace answer',
        },
      }],
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'trace-model',
        input: 'trace this request',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.output[0].content[0].text, 'trace answer');
    assert.deepEqual(events.map((event) => event.type), [
      'request.received',
      'request.translated',
      'response.translated',
    ]);
    assert.equal(events[0].route, 'responses');
    assert.equal(events[0].model, 'trace-model');
    assert.equal(events[1].upstreamRequest.model, 'trace-model');
    assert.equal(events[2].response.output[0].content[0].text, 'trace answer');
  } finally {
    await server.stop();
  }
});

test('adapter server trace sink captures downgrade and filter adjustments', async () => {
  const events: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    traceSink: (event) => {
      events.push(JSON.parse(JSON.stringify(event)));
    },
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
      multimodal: {
        supportsImageInput: false,
        supportsFileInput: false,
        unsupportedInputPartStrategy: 'text-placeholder',
      },
      payload: {
        filter: [
          { paths: ['parallel_tool_calls'] },
          { paths: ['response_format'] },
        ],
      },
      modelCapabilities: {
        'trace-model': {
          maxOutputTokens: 1024,
        },
      },
    },
    fetchImpl: (async () => new Response(JSON.stringify({
      id: 'chatcmpl_trace_adjustments',
      created: 1_700_000_211,
      model: 'trace-model',
      choices: [{
        message: {
          content: 'trace answer',
        },
      }],
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'trace-model',
        max_output_tokens: 4000,
        parallel_tool_calls: true,
        tool_choice: 'web_search_preview',
        text: {
          format: {
            type: 'json_schema',
            name: 'trace_response',
            schema: {
              type: 'object',
            },
          },
        },
        tools: [
          {
            type: 'function',
            name: 'lookup',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
          {
            type: 'web_search_preview',
          },
        ],
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'hello' },
            { type: 'input_image', image_url: 'https://example.com/cat.png' },
            { type: 'input_file', file_url: 'https://example.com/spec.pdf' },
          ],
        }],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(events.map((event) => event.type), [
      'request.received',
      'request.translated',
      'request.adjusted',
      'response.translated',
    ]);
    assert.deepEqual(events[2].adjustments, [
      {
        kind: 'max_output_tokens_capped',
        path: 'max_output_tokens',
        reason: 'model_limit',
        before: 4000,
        after: 1024,
      },
      {
        kind: 'field_filtered',
        path: 'parallel_tool_calls',
        reason: 'payload_filter',
        before: true,
      },
      {
        kind: 'field_filtered',
        path: 'text.format',
        reason: 'payload_filter_or_unsupported_format',
        before: {
          type: 'json_schema',
          name: 'trace_response',
          schema: {
            type: 'object',
          },
        },
      },
      {
        kind: 'tools_dropped',
        path: 'tools',
        reason: 'builtin_web_search_unsupported',
        requestedCount: 1,
        forwardedCount: 0,
      },
      {
        kind: 'tool_choice_dropped',
        path: 'tool_choice',
        reason: 'unsupported_or_filtered',
        before: 'web_search_preview',
      },
      {
        kind: 'image_input_downgraded',
        path: 'input.image',
        reason: 'unsupported_input_part_strategy',
        requestedCount: 1,
        forwardedCount: 0,
        strategy: 'text-placeholder',
      },
      {
        kind: 'file_input_downgraded',
        path: 'input.file',
        reason: 'unsupported_input_part_strategy',
        requestedCount: 1,
        forwardedCount: 0,
        strategy: 'text-placeholder',
      },
    ]);
  } finally {
    await server.stop();
  }
});

test('adapter server exposes model metadata from package boundary', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    defaultModel: 'example-model',
    providerKind: 'iflow',
    providerName: 'iFlow',
    ownedBy: 'iflow',
    models: [{
      id: 'example-model',
      contextWindow: 128000,
      pricing: {
        inputCostPerToken: 1.5e-7,
        outputCostPerToken: 6e-7,
      },
      capabilities: {
        tools: true,
        vision: false,
        reasoning: {
          supportedReasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
        },
        thinking: {
          mode: 'boolean',
          booleanField: 'chat_template_kwargs.enable_thinking',
          stripFields: ['reasoning_effort', 'thinking'],
          booleanFalseEfforts: ['none'],
        },
        payload: {
          override: [{
            params: {
              model: 'provider/example-model',
            },
          }],
        },
        parallelToolCalls: false,
        maxOutputTokens: 4096,
        retry: {
          maxAttempts: 4,
          retryStatuses: [408, 429, 503],
          baseDelayMs: 500,
          maxDelayMs: 4_000,
          retryAfterMaxMs: 45_000,
          retryNetworkErrors: true,
        },
      },
    }],
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
      supportsResponsesCompact: false,
      retry: {
        maxAttempts: 2,
        retryStatuses: [429, 500],
        baseDelayMs: 250,
        maxDelayMs: 2_000,
        retryAfterMaxMs: 20_000,
        retryNetworkErrors: false,
      },
      multimodal: {
        supportsImageInput: true,
        supportsFileInput: false,
        unsupportedInputPartStrategy: 'text-placeholder',
      },
    },
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/models`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.deepEqual(body.meta, {
      provider: {
        kind: 'iflow',
        name: 'iFlow',
        ownedBy: 'iflow',
      },
      defaults: {
        model: 'example-model',
      },
      retry: {
        enabled: true,
        maxAttempts: 2,
        retryStatuses: [429, 500],
        baseDelayMs: 250,
        maxDelayMs: 2000,
        retryAfterMaxMs: 20000,
        retryNetworkErrors: false,
      },
      routes: {
        primary: {
          models: '/models',
          responses: '/responses',
          responsesCompact: '/responses/compact',
        },
        compatibility: {
          models: '/v1/models',
          responses: '/v1/responses',
          responsesCompact: '/v1/responses/compact',
        },
        upstream: {
          chatCompletions: '/chat/completions',
          responsesCompact: null,
        },
      },
    });
    assert.equal(body.data[0].id, 'example-model');
    assert.equal(body.data[0].contextWindow, 128000);
    assert.deepEqual(body.data[0].pricing, {
      inputCostPerToken: 1.5e-7,
      outputCostPerToken: 6e-7,
    });
    assert.deepEqual(body.data[0].capabilities, {
      tools: true,
      vision: false,
      reasoning: {
        supportedReasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
      },
      thinking: {
        mode: 'boolean',
        booleanField: 'chat_template_kwargs.enable_thinking',
        stripFields: ['reasoning_effort', 'thinking'],
        booleanFalseEfforts: ['none'],
      },
      payload: {
        override: [{
          params: {
            model: 'provider/example-model',
          },
        }],
      },
      parallelToolCalls: false,
      maxOutputTokens: 4096,
      retry: {
        maxAttempts: 4,
        retryStatuses: [408, 429, 503],
        baseDelayMs: 500,
        maxDelayMs: 4000,
        retryAfterMaxMs: 45000,
        retryNetworkErrors: true,
      },
    });
    assert.deepEqual(body.data[0].capabilityCatalog, {
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
        supportedReasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
      },
      responses: {
        compact: false,
      },
      limits: {
        maxOutputTokens: 4096,
      },
      quirks: [
        'parallel_tool_calls_filtered',
        'upstream_model_alias_required',
        'provider_specific_thinking_toggle',
        'text_placeholder_for_unsupported_input_parts',
      ],
    });
    assert.deepEqual(body.data[0].protocol, {
      tools: {
        supported: true,
        builtinWebSearch: false,
        parallelToolCalls: false,
      },
      multimodal: {
        imageInput: false,
        imageUrlInput: null,
        imageBase64Input: null,
        fileInput: false,
        pdfInput: false,
        fileDataInput: null,
        fileIdInput: null,
        fileUrlInput: null,
        unsupportedInputPartStrategy: 'text-placeholder',
      },
      reasoning: {
        supported: true,
        supportedReasoningEfforts: ['low', 'high'],
        defaultReasoningEffort: 'high',
        transport: {
          mode: 'boolean',
          booleanField: 'chat_template_kwargs.enable_thinking',
          strippedFields: ['reasoning_effort', 'thinking'],
        },
      },
      retry: {
        enabled: true,
        maxAttempts: 4,
        retryStatuses: [408, 429, 503],
        baseDelayMs: 500,
        maxDelayMs: 4000,
        retryAfterMaxMs: 45000,
        retryNetworkErrors: true,
      },
      structuredOutput: {
        jsonSchema: true,
      },
      responses: {
        supportsCompact: false,
      },
      routing: {
        upstreamModel: 'provider/example-model',
        requiresModelAlias: true,
      },
      limits: {
        maxOutputTokens: 4096,
      },
    });
  } finally {
    await server.stop();
  }
});

test('adapter server applies model-specific retry overrides during upstream retries', async () => {
  const fetchCalls = new Map<string, number>();
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      retry: {
        maxAttempts: 2,
        retryStatuses: [429],
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryAfterMaxMs: 0,
        retryNetworkErrors: false,
      },
      modelCapabilities: {
        'strict-model': {
          retry: {
            maxAttempts: 1,
          },
        },
      },
      usage: {
        estimateWhenMissing: true,
      },
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      const model = String(requestBody?.model ?? 'unknown');
      const attempt = (fetchCalls.get(model) ?? 0) + 1;
      fetchCalls.set(model, attempt);
      if (attempt === 1) {
        return new Response(JSON.stringify({
          error: {
            message: `retry me once for ${model}`,
            type: 'rate_limit_error',
          },
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }
      return new Response(JSON.stringify({
        id: `chatcmpl_${model}_${attempt}`,
        created: 1_700_000_300,
        model,
        choices: [{
          message: {
            content: `recovered for ${model}`,
          },
        }],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const strictResponse = await fetch(`${server.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'strict-model',
        input: 'do not retry this model',
      }),
    });
    const strictBody = await strictResponse.json() as any;
    assert.equal(strictResponse.status, 429);
    assert.equal(fetchCalls.get('strict-model'), 1);
    assert.equal(strictBody.error.category, 'rate_limit');

    const retryResponse = await fetch(`${server.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'retry-model',
        input: 'retry this model once',
      }),
    });
    const retryBody = await retryResponse.json() as any;
    assert.equal(retryResponse.status, 200);
    assert.equal(fetchCalls.get('retry-model'), 2);
    assert.equal(retryBody.output[0].content[0].text, 'recovered for retry-model');
  } finally {
    await server.stop();
  }
});

test('adapter server keeps Responses-first root routes while preserving /v1 aliases', async () => {
  let fetchCalls = 0;
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    models: [{
      id: 'root-route-model',
      contextWindow: 64000,
    }],
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        id: 'chatcmpl_root_route',
        created: 1_700_000_050,
        model: 'root-route-model',
        choices: [{
          message: {
            content: 'root route answer',
          },
        }],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
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
    const modelsResponse = await fetch(`${server.baseUrl}/models`);
    const modelsBody = await modelsResponse.json() as any;
    assert.equal(modelsResponse.status, 200);
    assert.equal(modelsBody.data[0].id, 'root-route-model');

    const response = await fetch(`${server.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'root-route-model',
        input: 'hello via root route',
      }),
    });
    const responseBody = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(responseBody.object, 'response');
    assert.equal(responseBody.output[0].content[0].text, 'root route answer');

    const compactResponse = await fetch(`${server.baseUrl}/responses/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'root-route-model',
        input: 'hello compact root route',
      }),
    });
    const compactBody = await compactResponse.json() as any;
    assert.equal(compactResponse.status, 200);
    assert.equal(compactBody.object, 'response.compaction');
    assert.equal(compactBody.output[0].content[0].text, 'hello compact root route');
    assert.equal(fetchCalls, 1);
  } finally {
    await server.stop();
  }
});

test('reserveLocalPort is exported from the package boundary', async () => {
  const port = await reserveLocalPort();
  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 0, true);
});

test('adapter server preserves previous_response_id in non-streaming responses', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => new Response(JSON.stringify({
      id: 'chatcmpl_prev_turn',
      created: 1_700_000_101,
      model: 'example-model',
      choices: [{
        message: {
          content: 'follow-up answer',
        },
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 4,
        total_tokens: 9,
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        previous_response_id: 'resp_parent_123',
        input: 'continue',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.previous_response_id, 'resp_parent_123');
    assert.equal(body.output[0].content[0].text, 'follow-up answer');
  } finally {
    await server.stop();
  }
});

test('adapter server completes a custom tool-call loop over Chat Completions', async () => {
  const upstreamRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chatcmpl_custom_loop_1',
          created: 1_700_000_401,
          model: 'tool-loop-model',
          choices: [{
            message: {
              tool_calls: [{
                id: 'call_exec_1',
                type: 'function',
                function: {
                  name: 'exec',
                  arguments: '{"input":"ls -la"}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl_custom_loop_2',
        created: 1_700_000_402,
        model: 'tool-loop-model',
        choices: [{
          message: {
            content: 'saw the tool result',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const firstResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tool-loop-model',
        input: 'list workspace',
        tools: [{
          type: 'custom',
          name: 'exec',
          description: 'Run a local command.',
        }],
      }),
    });
    const firstBody = await firstResponse.json() as any;
    assert.equal(firstResponse.status, 200);
    assert.equal(firstBody.output[0].type, 'custom_tool_call');
    assert.equal(firstBody.output[0].name, 'exec');
    assert.equal(firstBody.output[0].input, 'ls -la');
    assert.deepEqual(upstreamRequests[0].tools.map((tool: any) => tool.function.name), ['exec']);

    const secondResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tool-loop-model',
        input: [
          firstBody.output[0],
          {
            type: 'custom_tool_call_output',
            call_id: 'call_exec_1',
            output: 'total 8\nREADME.md\npackage.json',
          },
        ],
        tools: [{
          type: 'custom',
          name: 'exec',
        }],
      }),
    });
    const secondBody = await secondResponse.json() as any;
    assert.equal(secondResponse.status, 200);
    assert.equal(secondBody.output[0].content[0].text, 'saw the tool result');
    assert.equal(upstreamRequests[1].messages[0].role, 'assistant');
    assert.equal(upstreamRequests[1].messages[0].tool_calls[0].id, 'call_exec_1');
    assert.equal(upstreamRequests[1].messages[0].tool_calls[0].function.name, 'exec');
    assert.equal(upstreamRequests[1].messages[0].tool_calls[0].function.arguments, '{"input":"ls -la"}');
    assert.equal(upstreamRequests[1].messages[1].role, 'tool');
    assert.equal(upstreamRequests[1].messages[1].tool_call_id, 'call_exec_1');
    assert.equal(upstreamRequests[1].messages[1].content, 'total 8\nREADME.md\npackage.json');
  } finally {
    await server.stop();
  }
});

test('adapter server executes relay-emulated web_search inside the Chat Completions loop', async () => {
  const upstreamRequests: any[] = [];
  const executedRequests: any[] = [];
  const traceEvents: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'web_search',
      mode: 'relay-emulated',
      relayToolName: 'relay_web_search',
    }],
    hostedToolExecutors: {
      web_search: async (request) => {
        executedRequests.push(JSON.parse(JSON.stringify(request)));
        return {
          content: {
            results: [{
              title: 'Codex Relay Result',
              url: 'https://example.com/codex-relay',
              snippet: 'Relay executed web search locally.',
            }],
          },
        };
      },
    },
    traceSink: (event) => {
      traceEvents.push(JSON.parse(JSON.stringify(event)));
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        assert.equal(requestBody.tools[0].function.name, 'relay_web_search');
        assert.deepEqual(requestBody.tool_choice, {
          type: 'function',
          function: {
            name: 'relay_web_search',
          },
        });
        return new Response(JSON.stringify({
          id: 'chatcmpl_relay_search_1',
          created: 1_700_000_451,
          model: 'relay-search-model',
          choices: [{
            message: {
              tool_calls: [{
                id: 'call_search_1',
                type: 'function',
                function: {
                  name: 'relay_web_search',
                  arguments: '{"query":"codex relay web search"}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      assert.equal(requestBody.messages.at(-2).role, 'assistant');
      assert.equal(requestBody.messages.at(-2).tool_calls[0].function.name, 'relay_web_search');
      assert.equal(requestBody.messages.at(-1).role, 'tool');
      assert.equal(requestBody.messages.at(-1).tool_call_id, 'call_search_1');
      assert.match(requestBody.messages.at(-1).content, /Codex Relay Result/u);
      return new Response(JSON.stringify({
        id: 'chatcmpl_relay_search_2',
        created: 1_700_000_452,
        model: 'relay-search-model',
        choices: [{
          message: {
            content: 'I searched through the relay.',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-search-model',
        input: 'Find current relay info.',
        tools: [{
          type: 'web_search_preview',
        }],
        tool_choice: 'web_search_preview',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 2);
    assert.equal(executedRequests.length, 1);
    assert.equal(executedRequests[0].toolName, 'web_search');
    assert.equal(executedRequests[0].relayToolName, 'relay_web_search');
    assert.equal(executedRequests[0].arguments.query, 'codex relay web search');
    assert.equal(body.output[0].content[0].text, 'I searched through the relay.');
    assert.equal(traceEvents.some((event) => event.type === 'hosted_tool.executed'), true);
    assert.equal(traceEvents.some((event) => (
      event.type === 'request.adjusted'
      && event.adjustments?.some((adjustment: any) => adjustment.reason === 'builtin_web_search_unsupported')
    )), false);
  } finally {
    await server.stop();
  }
});

test('adapter server appends deferred tools returned by relay-emulated tool_search', async () => {
  const upstreamRequests: any[] = [];
  const executedRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'tool_search',
      mode: 'relay-emulated',
      relayToolName: 'relay_tool_search',
    }],
    hostedToolExecutors: {
      tool_search: async (request) => {
        executedRequests.push(JSON.parse(JSON.stringify(request)));
        return {
          content: {
            tools: [{
              type: 'function',
              function: {
                name: 'lookup_docs',
                description: 'Look up documentation.',
                parameters: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                  },
                  required: ['query'],
                },
              },
            }],
          },
        };
      },
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        assert.equal(requestBody.tools.length, 1);
        assert.equal(requestBody.tools[0].function.name, 'relay_tool_search');
        assert.deepEqual(requestBody.tool_choice, {
          type: 'function',
          function: {
            name: 'relay_tool_search',
          },
        });
        return new Response(JSON.stringify({
          id: 'chatcmpl_tool_search_1',
          created: 1_700_000_491,
          model: 'relay-tool-search-model',
          choices: [{
            message: {
              tool_calls: [{
                id: 'call_tool_search_1',
                type: 'function',
                function: {
                  name: 'relay_tool_search',
                  arguments: '{"query":"documentation"}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      assert.equal(requestBody.messages.at(-2).tool_calls[0].function.name, 'relay_tool_search');
      assert.equal(requestBody.messages.at(-1).role, 'tool');
      assert.equal(requestBody.messages.at(-1).tool_call_id, 'call_tool_search_1');
      assert.equal(requestBody.tools.some((tool: any) => tool.function?.name === 'relay_tool_search'), true);
      assert.equal(requestBody.tools.some((tool: any) => tool.function?.name === 'lookup_docs'), true);
      assert.equal(requestBody.tool_choice, undefined);
      return new Response(JSON.stringify({
        id: 'chatcmpl_tool_search_2',
        created: 1_700_000_492,
        model: 'relay-tool-search-model',
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_lookup_docs_1',
              type: 'function',
              function: {
                name: 'lookup_docs',
                arguments: '{"query":"documentation"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-tool-search-model',
        input: 'Find a documentation tool.',
        tools: [{
          type: 'tool_search',
        }],
        tool_choice: 'tool_search',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 2);
    assert.equal(executedRequests.length, 1);
    assert.equal(executedRequests[0].toolName, 'tool_search');
    assert.equal(executedRequests[0].arguments.query, 'documentation');
    assert.equal(body.output[0].type, 'function_call');
    assert.equal(body.output[0].name, 'lookup_docs');
  } finally {
    await server.stop();
  }
});

test('adapter server executes relay-emulated image_generation and can expose image output', async () => {
  const upstreamRequests: any[] = [];
  const executedRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'image_generation',
      mode: 'relay-emulated',
      relayToolName: 'relay_image_generation',
    }],
    hostedToolExecutors: {
      image_generation: async (request) => {
        executedRequests.push(JSON.parse(JSON.stringify(request)));
        return {
          content: {
            prompt: request.arguments.prompt,
            images: [{
              b64_json: 'aW1hZ2U=',
              mime_type: 'image/png',
              revised_prompt: 'A relay bridge over water.',
            }],
          },
        };
      },
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        assert.equal(requestBody.tools[0].function.name, 'relay_image_generation');
        assert.deepEqual(requestBody.tool_choice, {
          type: 'function',
          function: {
            name: 'relay_image_generation',
          },
        });
        return new Response(JSON.stringify({
          id: 'chatcmpl_image_1',
          created: 1_700_000_501,
          model: 'relay-image-model',
          choices: [{
            message: {
              tool_calls: [{
                id: 'call_image_1',
                type: 'function',
                function: {
                  name: 'relay_image_generation',
                  arguments: '{"prompt":"a relay bridge","size":"1024x1024","output_format":"png","n":1}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      assert.equal(requestBody.messages.at(-2).tool_calls[0].function.name, 'relay_image_generation');
      assert.equal(requestBody.messages.at(-1).role, 'tool');
      assert.equal(requestBody.messages.at(-1).tool_call_id, 'call_image_1');
      assert.match(requestBody.messages.at(-1).content, /aW1hZ2U=/u);
      return new Response(JSON.stringify({
        id: 'chatcmpl_image_2',
        created: 1_700_000_502,
        model: 'relay-image-model',
        choices: [{
          message: {
            content: 'Generated the image through the relay.',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-image-model',
        input: 'Generate an image.',
        tools: [{
          type: 'image_generation',
        }],
        tool_choice: 'image_generation',
        include: ['image_generation_call.results'],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 2);
    assert.equal(executedRequests.length, 1);
    assert.equal(executedRequests[0].toolName, 'image_generation');
    assert.equal(executedRequests[0].arguments.prompt, 'a relay bridge');
    assert.equal(body.output[0].content[0].text, 'Generated the image through the relay.');
    assert.equal(body.output[1].type, 'image_generation_call');
    assert.equal(body.output[1].result[0].b64_json, 'aW1hZ2U=');
    assert.equal(body.output[1].result[0].mime_type, 'image/png');
  } finally {
    await server.stop();
  }
});

test('adapter server executes relay-emulated code_interpreter inside the Chat Completions loop', async () => {
  const upstreamRequests: any[] = [];
  const executedRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'code_interpreter',
      mode: 'relay-emulated',
      relayToolName: 'relay_code_interpreter',
    }],
    hostedToolExecutors: {
      code_interpreter: createCodexProviderRelayCodeInterpreterExecutor({
        async execute(request) {
          executedRequests.push(JSON.parse(JSON.stringify({
            code: request.code,
            language: request.language,
            container: request.container,
            files: request.files,
          })));
          return {
            stdout: 'total=3\n',
            result: {
              total: 3,
            },
          };
        },
      }),
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        assert.equal(requestBody.tools[0].function.name, 'relay_code_interpreter');
        assert.deepEqual(requestBody.tool_choice, {
          type: 'function',
          function: {
            name: 'relay_code_interpreter',
          },
        });
        return new Response(JSON.stringify({
          id: 'chatcmpl_code_1',
          created: 1_700_000_511,
          model: 'relay-code-model',
          choices: [{
            message: {
              tool_calls: [{
                id: 'call_code_1',
                type: 'function',
                function: {
                  name: 'relay_code_interpreter',
                  arguments: '{"code":"print(1 + 2)","language":"python","container":{"type":"auto"},"files":[{"filename":"input.txt","content":"1,2"}]}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      assert.equal(requestBody.messages.at(-2).tool_calls[0].function.name, 'relay_code_interpreter');
      assert.equal(requestBody.messages.at(-1).role, 'tool');
      assert.equal(requestBody.messages.at(-1).tool_call_id, 'call_code_1');
      assert.match(requestBody.messages.at(-1).content, /total=3/u);
      assert.match(requestBody.messages.at(-1).content, /"total":3/u);
      return new Response(JSON.stringify({
        id: 'chatcmpl_code_2',
        created: 1_700_000_512,
        model: 'relay-code-model',
        choices: [{
          message: {
            content: 'Executed code through the relay.',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-code-model',
        input: 'Run this code.',
        tools: [{
          type: 'code_interpreter',
        }],
        tool_choice: 'code_interpreter',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 2);
    assert.equal(executedRequests.length, 1);
    assert.deepEqual(executedRequests[0], {
      code: 'print(1 + 2)',
      language: 'python',
      container: {
        type: 'auto',
      },
      files: [{
        filename: 'input.txt',
        content: '1,2',
      }],
    });
    assert.equal(body.output[0].content[0].text, 'Executed code through the relay.');
  } finally {
    await server.stop();
  }
});

test('adapter server does not expose relay-emulated code_interpreter without an executor', async () => {
  const upstreamRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'code_interpreter',
      mode: 'relay-emulated',
      relayToolName: 'relay_code_interpreter',
    }],
    hostedToolExecutors: {},
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      assert.equal(requestBody.tools, undefined);
      assert.equal(requestBody.tool_choice, undefined);
      return new Response(JSON.stringify({
        id: 'chatcmpl_code_no_executor',
        created: 1_700_000_513,
        model: 'relay-code-model',
        choices: [{
          message: {
            content: 'No code tool was exposed.',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-code-model',
        input: 'Run this code.',
        tools: [{
          type: 'code_interpreter',
        }],
        tool_choice: 'code_interpreter',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(body.output[0].content[0].text, 'No code tool was exposed.');
  } finally {
    await server.stop();
  }
});

test('adapter server executes relay-emulated computer actions inside the Chat Completions loop', async () => {
  const upstreamRequests: any[] = [];
  const executedRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'computer',
      mode: 'relay-emulated',
      relayToolName: 'relay_computer',
    }],
    hostedToolExecutors: {
      computer: createCodexProviderRelayComputerExecutor({
        async execute(request) {
          executedRequests.push(JSON.parse(JSON.stringify({
            actions: request.actions,
            display: request.display,
          })));
          return {
            screenshot: {
              b64_png: 'aW1hZ2U=',
              detail: 'high',
            },
            observations: ['Clicked search field', 'Screenshot captured'],
          };
        },
      }),
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        assert.equal(requestBody.tools[0].function.name, 'relay_computer');
        assert.deepEqual(requestBody.tool_choice, {
          type: 'function',
          function: {
            name: 'relay_computer',
          },
        });
        return new Response(JSON.stringify({
          id: 'chatcmpl_computer_1',
          created: 1_700_000_521,
          model: 'relay-computer-model',
          choices: [{
            message: {
              tool_calls: [{
                id: 'call_computer_1',
                type: 'function',
                function: {
                  name: 'relay_computer',
                  arguments: '{"actions":[{"type":"click","x":10,"y":20},{"type":"screenshot"}],"display":{"width":1280,"height":720,"environment":"browser"}}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      assert.equal(requestBody.messages.at(-2).tool_calls[0].function.name, 'relay_computer');
      assert.equal(requestBody.messages.at(-1).role, 'tool');
      assert.equal(requestBody.messages.at(-1).tool_call_id, 'call_computer_1');
      assert.match(requestBody.messages.at(-1).content, /Screenshot captured/u);
      assert.match(requestBody.messages.at(-1).content, /aW1hZ2U=/u);
      return new Response(JSON.stringify({
        id: 'chatcmpl_computer_2',
        created: 1_700_000_522,
        model: 'relay-computer-model',
        choices: [{
          message: {
            content: 'Used the computer through the relay.',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-computer-model',
        input: 'Use the computer.',
        tools: [{
          type: 'computer_use_preview',
        }],
        tool_choice: 'computer_use_preview',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 2);
    assert.equal(executedRequests.length, 1);
    assert.deepEqual(executedRequests[0], {
      actions: [{
        type: 'click',
        x: 10,
        y: 20,
      }, {
        type: 'screenshot',
      }],
      display: {
        width: 1280,
        height: 720,
        environment: 'browser',
      },
    });
    assert.equal(body.output[0].content[0].text, 'Used the computer through the relay.');
  } finally {
    await server.stop();
  }
});

test('adapter server does not expose relay-emulated computer without an executor', async () => {
  const upstreamRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'computer',
      mode: 'relay-emulated',
      relayToolName: 'relay_computer',
    }],
    hostedToolExecutors: {},
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      assert.equal(requestBody.tools, undefined);
      assert.equal(requestBody.tool_choice, undefined);
      return new Response(JSON.stringify({
        id: 'chatcmpl_computer_no_executor',
        created: 1_700_000_523,
        model: 'relay-computer-model',
        choices: [{
          message: {
            content: 'No computer tool was exposed.',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-computer-model',
        input: 'Use the computer.',
        tools: [{
          type: 'computer',
        }],
        tool_choice: 'computer',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(body.output[0].content[0].text, 'No computer tool was exposed.');
  } finally {
    await server.stop();
  }
});

test('adapter server streams final answer after relay-emulated web_search execution', async () => {
  const upstreamRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'web_search',
      mode: 'relay-emulated',
      relayToolName: 'relay_web_search',
    }],
    hostedToolExecutors: {
      web_search: async () => ({
        content: {
          results: [{
            title: 'Streaming Relay Result',
            url: 'https://example.com/streaming-relay',
          }],
        },
      }),
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      assert.equal(requestBody.stream, true);
      if (upstreamRequests.length === 1) {
        return createEventStreamResponse([
          {
            id: 'chatcmpl_stream_relay_search_1',
            created: 1_700_000_461,
            model: 'relay-search-model',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_search_stream_1',
                  type: 'function',
                  function: {
                    name: 'relay_web_search',
                    arguments: '{"query"',
                  },
                }],
              },
            }],
          },
          {
            id: 'chatcmpl_stream_relay_search_1',
            created: 1_700_000_461,
            model: 'relay-search-model',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  function: {
                    arguments: ':"stream relay search"}',
                  },
                }],
              },
            }],
          },
          {
            id: 'chatcmpl_stream_relay_search_1',
            created: 1_700_000_461,
            model: 'relay-search-model',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
            }],
          },
        ]);
      }
      assert.equal(requestBody.messages.at(-2).role, 'assistant');
      assert.equal(requestBody.messages.at(-2).tool_calls[0].id, 'call_search_stream_1');
      assert.equal(requestBody.messages.at(-2).tool_calls[0].function.name, 'relay_web_search');
      assert.equal(requestBody.messages.at(-1).role, 'tool');
      assert.match(requestBody.messages.at(-1).content, /Streaming Relay Result/u);
      return createEventStreamResponse([
        {
          id: 'chatcmpl_stream_relay_search_2',
          created: 1_700_000_462,
          model: 'relay-search-model',
          choices: [{
            index: 0,
            delta: {
              content: 'stream-compatible ',
            },
          }],
        },
        {
          id: 'chatcmpl_stream_relay_search_2',
          created: 1_700_000_462,
          model: 'relay-search-model',
          choices: [{
            index: 0,
            delta: {
              content: 'final answer',
            },
          }],
        },
        {
          id: 'chatcmpl_stream_relay_search_2',
          created: 1_700_000_462,
          model: 'relay-search-model',
          choices: [{
            index: 0,
            finish_reason: 'stop',
          }],
        },
      ]);
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-search-model',
        input: 'Find current relay info.',
        stream: true,
        tools: [{
          type: 'web_search_preview',
        }],
      }),
    });
    const text = await response.text();
    const events = parseSseText(text);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type')?.includes('text/event-stream'), true);
    assert.equal(upstreamRequests.length, 2);
    assert.equal(events.filter((event) => event.event === 'response.output_text.delta').length, 2);
    assert.equal(events.at(-1)?.event, 'response.completed');
    assert.equal(events.at(-1)?.data.response.output[0].content[0].text, 'stream-compatible final answer');
  } finally {
    await server.stop();
  }
});

test('adapter server streams final answer after relay-emulated file_search execution', async () => {
  const upstreamRequests: any[] = [];
  const executedRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'file_search',
      mode: 'relay-emulated',
      relayToolName: 'relay_file_search',
    }],
    hostedToolExecutors: {
      file_search: async (request) => {
        executedRequests.push(JSON.parse(JSON.stringify(request)));
        return {
          content: {
            object: 'vector_store.search_results.page',
            query: request.arguments.query,
            search_query: request.arguments.query,
            provider: 'local-fs',
            data: [{
              file_id: 'file_agent',
              filename: 'agent.ts',
              score: 1,
              attributes: {
                path: 'src/agent.ts',
                source: 'local-fs',
              },
              content: [{
                type: 'text',
                text: 'file search target',
                line: 2,
                start_line: 2,
                end_line: 2,
              }],
            }],
            search_results: [{
              file_id: 'file_agent',
              filename: 'agent.ts',
              score: 1,
              attributes: {
                path: 'src/agent.ts',
                source: 'local-fs',
              },
              content: [{
                type: 'text',
                text: 'file search target',
                line: 2,
                start_line: 2,
                end_line: 2,
              }],
            }],
            has_more: false,
            next_page: null,
          },
        };
      },
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      assert.equal(requestBody.stream, true);
      if (upstreamRequests.length === 1) {
        assert.equal(requestBody.tools[0].function.name, 'relay_file_search');
        return createEventStreamResponse([
          {
            id: 'chatcmpl_stream_file_search_1',
            created: 1_700_000_467,
            model: 'relay-search-model',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_file_search_1',
                  type: 'function',
                  function: {
                    name: 'relay_file_search',
                    arguments: '{"query":"file search target","path_glob":"src/*"}',
                  },
                }],
              },
            }],
          },
          {
            id: 'chatcmpl_stream_file_search_1',
            created: 1_700_000_467,
            model: 'relay-search-model',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
            }],
          },
        ]);
      }
      assert.equal(requestBody.messages.at(-2).tool_calls[0].function.name, 'relay_file_search');
      assert.equal(requestBody.messages.at(-1).role, 'tool');
      assert.match(requestBody.messages.at(-1).content, /src\/agent\.ts/u);
      return createEventStreamResponse([
        {
          id: 'chatcmpl_stream_file_search_2',
          created: 1_700_000_468,
          model: 'relay-search-model',
          choices: [{
            index: 0,
            delta: {
              content: 'file search final answer',
            },
          }],
        },
        {
          id: 'chatcmpl_stream_file_search_2',
          created: 1_700_000_468,
          model: 'relay-search-model',
          choices: [{
            index: 0,
            finish_reason: 'stop',
          }],
        },
      ]);
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-search-model',
        input: 'Search configured files.',
        stream: true,
        tools: [{
          type: 'file_search',
        }],
      }),
    });
    const events = parseSseText(await response.text());
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 2);
    assert.equal(executedRequests[0].toolName, 'file_search');
    assert.equal(executedRequests[0].arguments.path_glob, 'src/*');
    assert.equal(events.at(-1)?.data.response.output[0].content[0].text, 'file search final answer');
  } finally {
    await server.stop();
  }
});

test('adapter server exposes relay-emulated file_search results when include requests them', async () => {
  const upstreamRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'file_search',
      mode: 'relay-emulated',
      relayToolName: 'relay_file_search',
    }],
    hostedToolExecutors: {
      file_search: async (request) => ({
        content: {
          object: 'vector_store.search_results.page',
          query: request.arguments.query,
          search_query: request.arguments.query,
          provider: 'local-fs',
          data: [{
            file_id: 'file_include_agent',
            filename: 'agent.ts',
            score: 0.98,
            attributes: {
              path: 'src/agent.ts',
              source: 'local-fs',
            },
            content: [{
              type: 'text',
              text: 'included file search result',
              start_line: 7,
              end_line: 7,
            }],
          }],
          search_results: [],
          has_more: false,
          next_page: null,
        },
      }),
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chatcmpl_file_search_include_1',
          created: 1_700_000_469,
          model: 'relay-search-model',
          choices: [{
            message: {
              tool_calls: [{
                id: 'call_file_search_include_1',
                type: 'function',
                function: {
                  name: 'relay_file_search',
                  arguments: '{"query":"file search include target"}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl_file_search_include_2',
        created: 1_700_000_470,
        model: 'relay-search-model',
        choices: [{
          message: {
            content: 'file search answer with exposed results',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-search-model',
        input: 'Search configured files.',
        include: ['file_search_call.results'],
        tools: [{
          type: 'file_search',
        }],
      }),
    });
    const body = await response.json() as any;
    const fileSearchCall = body.output.find((item: any) => item.type === 'file_search_call');

    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 2);
    assert.equal(body.output[0].content[0].text, 'file search answer with exposed results');
    assert.equal(fileSearchCall.status, 'completed');
    assert.equal(fileSearchCall.call_id, 'call_file_search_include_1');
    assert.deepEqual(fileSearchCall.queries, ['file search include target']);
    assert.equal(fileSearchCall.results[0].file_id, 'file_include_agent');
    assert.equal(fileSearchCall.results[0].filename, 'agent.ts');
    assert.equal(fileSearchCall.results[0].content[0].text, 'included file search result');
  } finally {
    await server.stop();
  }
});

test('adapter server can expose hosted file_search results through server option', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    exposeHostedToolResultsInResponsesOutput: true,
    hostedTools: [{
      name: 'file_search',
      mode: 'relay-emulated',
      relayToolName: 'relay_file_search',
    }],
    hostedToolExecutors: {
      file_search: async () => ({
        content: {
          object: 'vector_store.search_results.page',
          data: [{
            file_id: 'file_option_agent',
            filename: 'option.md',
            score: 1,
            attributes: {},
            content: [{
              type: 'text',
              text: 'option exposed file result',
            }],
          }],
          search_results: [],
        },
      }),
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      if (requestBody.messages?.some((message: any) => message.role === 'tool')) {
        return new Response(JSON.stringify({
          id: 'chatcmpl_file_search_option_2',
          created: 1_700_000_472,
          model: 'relay-search-model',
          choices: [{
            message: {
              content: 'option final answer',
            },
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl_file_search_option_1',
        created: 1_700_000_471,
        model: 'relay-search-model',
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_file_search_option_1',
              type: 'function',
              function: {
                name: 'relay_file_search',
                arguments: '{"query":"option file search"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-search-model',
        input: 'Search configured files.',
        tools: [{
          type: 'file_search',
        }],
      }),
    });
    const body = await response.json() as any;
    const fileSearchCall = body.output.find((item: any) => item.type === 'file_search_call');

    assert.equal(response.status, 200);
    assert.equal(body.output[0].content[0].text, 'option final answer');
    assert.equal(fileSearchCall.results[0].file_id, 'file_option_agent');
  } finally {
    await server.stop();
  }
});

test('adapter server emits opt-in hosted tool SSE lifecycle events', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'web_search',
      mode: 'relay-emulated',
      relayToolName: 'relay_web_search',
    }],
    hostedToolExecutors: {
      web_search: async (request) => {
        await request.emitDelta?.('querying search provider', { phase: 'query' });
        return {
          content: {
            results: [{
              title: 'Observable Relay Result',
              url: 'https://example.com/observable-relay',
            }],
          },
          metadata: {
            provider: 'test-search',
          },
        };
      },
    },
    emitHostedToolSseEvents: true,
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      if (requestBody.messages.some((message: any) => message.role === 'tool')) {
        return createEventStreamResponse([
          {
            id: 'chatcmpl_observable_search_2',
            created: 1_700_000_464,
            model: 'relay-search-model',
            choices: [{
              index: 0,
              delta: {
                content: 'observable final answer',
              },
            }],
          },
          {
            id: 'chatcmpl_observable_search_2',
            created: 1_700_000_464,
            model: 'relay-search-model',
            choices: [{
              index: 0,
              finish_reason: 'stop',
            }],
          },
        ]);
      }
      return createEventStreamResponse([
        {
          id: 'chatcmpl_observable_search_1',
          created: 1_700_000_464,
          model: 'relay-search-model',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_observable_search_1',
                type: 'function',
                function: {
                  name: 'relay_web_search',
                  arguments: '{"query":"observable search"}',
                },
              }],
            },
          }],
        },
        {
          id: 'chatcmpl_observable_search_1',
          created: 1_700_000_464,
          model: 'relay-search-model',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
          }],
        },
      ]);
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-search-model',
        input: 'Find observable relay info.',
        stream: true,
        tools: [{
          type: 'web_search_preview',
        }],
      }),
    });
    const events = parseSseText(await response.text());
    assert.equal(response.status, 200);
    assert.deepEqual(events.slice(0, 3).map((event) => event.event), [
      'hosted_tool.started',
      'hosted_tool.delta',
      'hosted_tool.completed',
    ]);
    assert.equal(events[0].data.hosted_tool.name, 'web_search');
    assert.equal(events[0].data.hosted_tool.call_id, 'call_observable_search_1');
    assert.equal(events[1].data.hosted_tool.delta, 'querying search provider');
    assert.equal(events[1].data.hosted_tool.metadata.phase, 'query');
    assert.equal(events[2].data.hosted_tool.metadata.provider, 'test-search');
    assert.match(events[2].data.hosted_tool.output_preview, /Observable Relay Result/u);
    assert.equal(events.some((event) => event.event === 'response.output_text.delta'), true);
    assert.equal(events.at(-1)?.event, 'response.completed');
  } finally {
    await server.stop();
  }
});

test('adapter server emits code_interpreter stdout and stderr hosted tool deltas', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'code_interpreter',
      mode: 'relay-emulated',
      relayToolName: 'relay_code_interpreter',
    }],
    hostedToolExecutors: {
      code_interpreter: createCodexProviderRelayCodeInterpreterExecutor({
        async execute(request) {
          await request.emitStdout('stdout line\n', { phase: 'run' });
          await request.emitStderr('stderr line\n', { phase: 'warn' });
          return {
            stdout: 'stdout line\n',
            stderr: 'stderr line\n',
          };
        },
      }),
    },
    emitHostedToolSseEvents: true,
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      if (requestBody.messages.some((message: any) => message.role === 'tool')) {
        return createEventStreamResponse([
          {
            id: 'chatcmpl_observable_code_2',
            created: 1_700_000_514,
            model: 'relay-code-model',
            choices: [{
              index: 0,
              delta: {
                content: 'code final answer',
              },
            }],
          },
          {
            id: 'chatcmpl_observable_code_2',
            created: 1_700_000_514,
            model: 'relay-code-model',
            choices: [{
              index: 0,
              finish_reason: 'stop',
            }],
          },
        ]);
      }
      return createEventStreamResponse([
        {
          id: 'chatcmpl_observable_code_1',
          created: 1_700_000_514,
          model: 'relay-code-model',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_observable_code_1',
                type: 'function',
                function: {
                  name: 'relay_code_interpreter',
                  arguments: '{"code":"print(1)","language":"python"}',
                },
              }],
            },
          }],
        },
        {
          id: 'chatcmpl_observable_code_1',
          created: 1_700_000_514,
          model: 'relay-code-model',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
          }],
        },
      ]);
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-code-model',
        input: 'Run observable code.',
        stream: true,
        tools: [{
          type: 'code_interpreter',
        }],
      }),
    });
    const events = parseSseText(await response.text());
    assert.equal(response.status, 200);
    assert.deepEqual(events.slice(0, 4).map((event) => event.event), [
      'hosted_tool.started',
      'hosted_tool.delta',
      'hosted_tool.delta',
      'hosted_tool.completed',
    ]);
    assert.equal(events[0].data.hosted_tool.name, 'code_interpreter');
    assert.equal(events[1].data.hosted_tool.delta.stream, 'stdout');
    assert.equal(events[1].data.hosted_tool.delta.text, 'stdout line');
    assert.equal(events[1].data.hosted_tool.metadata.phase, 'run');
    assert.equal(events[2].data.hosted_tool.delta.stream, 'stderr');
    assert.equal(events[2].data.hosted_tool.delta.text, 'stderr line');
    assert.equal(events[2].data.hosted_tool.metadata.phase, 'warn');
    assert.equal(events.some((event) => event.event === 'response.output_text.delta'), true);
    assert.equal(events.at(-1)?.event, 'response.completed');
  } finally {
    await server.stop();
  }
});

test('adapter server emits hosted tool failed SSE events when an executor throws', async () => {
  const upstreamRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'web_search',
      mode: 'relay-emulated',
      relayToolName: 'relay_web_search',
    }],
    hostedToolExecutors: {
      web_search: async () => {
        throw new Error('search backend unavailable');
      },
    },
    emitHostedToolSseEvents: true,
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        return createEventStreamResponse([
          {
            id: 'chatcmpl_failed_search_1',
            created: 1_700_000_465,
            model: 'relay-search-model',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_failed_search_1',
                  type: 'function',
                  function: {
                    name: 'relay_web_search',
                    arguments: '{"query":"failed search"}',
                  },
                }],
              },
            }],
          },
          {
            id: 'chatcmpl_failed_search_1',
            created: 1_700_000_465,
            model: 'relay-search-model',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
            }],
          },
        ]);
      }
      assert.match(requestBody.messages.at(-1).content, /search backend unavailable/u);
      return createEventStreamResponse([
        {
          id: 'chatcmpl_failed_search_2',
          created: 1_700_000_466,
          model: 'relay-search-model',
          choices: [{
            index: 0,
            delta: {
              content: 'handled search failure',
            },
          }],
        },
        {
          id: 'chatcmpl_failed_search_2',
          created: 1_700_000_466,
          model: 'relay-search-model',
          choices: [{
            index: 0,
            finish_reason: 'stop',
          }],
        },
      ]);
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-search-model',
        input: 'Find failed relay info.',
        stream: true,
        tools: [{
          type: 'web_search_preview',
        }],
      }),
    });
    const events = parseSseText(await response.text());
    assert.equal(response.status, 200);
    assert.deepEqual(events.slice(0, 2).map((event) => event.event), [
      'hosted_tool.started',
      'hosted_tool.failed',
    ]);
    assert.equal(events[1].data.hosted_tool.error.message, 'search backend unavailable');
    assert.equal(events.at(-1)?.data.response.output[0].content[0].text, 'handled search failure');
  } finally {
    await server.stop();
  }
});

test('adapter server rejects streamed turns that mix relay and non-relay tool calls', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
    hostedTools: [{
      name: 'web_search',
      mode: 'relay-emulated',
      relayToolName: 'relay_web_search',
    }],
    hostedToolExecutors: {
      web_search: async () => ({
        content: {
          results: [],
        },
      }),
    },
    fetchImpl: (async () => createEventStreamResponse([
      {
        id: 'chatcmpl_mixed_tool_stream_1',
        created: 1_700_000_463,
        model: 'relay-search-model',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [
              {
                id: 'call_search_stream_1',
                index: 0,
                type: 'function',
                function: {
                  name: 'relay_web_search',
                  arguments: '{"query":"stream relay search"}',
                },
              },
              {
                id: 'call_regular_1',
                index: 1,
                type: 'function',
                function: {
                  name: 'regular_tool',
                  arguments: '{}',
                },
              },
            ],
          },
        }],
      },
      {
        id: 'chatcmpl_mixed_tool_stream_1',
        created: 1_700_000_463,
        model: 'relay-search-model',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
        }],
      },
    ])) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'relay-search-model',
        input: 'Find current relay info.',
        stream: true,
        tools: [{
          type: 'web_search_preview',
        }, {
          type: 'function',
          name: 'regular_tool',
          parameters: {},
        }],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 502);
    assert.equal(body.error.code, 'relay_hosted_streaming_tool_mix_unsupported');
  } finally {
    await server.stop();
  }
});

test('adapter server retries forced tool_choice as auto when upstream thinking mode rejects it', async () => {
  const upstreamRequests: any[] = [];
  const traceEvents: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    traceSink: (event) => {
      traceEvents.push(JSON.parse(JSON.stringify(event)));
    },
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        return new Response(JSON.stringify({
          error: {
            message: 'The tool_choice parameter does not support being set to required or object in thinking mode',
            type: 'invalid_request_error',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl_tool_choice_retry',
        created: 1_700_000_403,
        model: 'tool-loop-model',
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_exec_retry',
              type: 'function',
              function: {
                name: 'exec',
                arguments: '{"input":"pwd"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tool-loop-model',
        input: 'run pwd',
        tools: [{
          type: 'custom',
          name: 'exec',
          description: 'Run a local command.',
        }],
        tool_choice: {
          type: 'custom',
          name: 'exec',
        },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests.length, 2);
    assert.ok(upstreamRequests[0].tool_choice);
    assert.equal(upstreamRequests[0].tools[0].function.name, 'exec');
    assert.equal(upstreamRequests[1].tool_choice, undefined);
    assert.equal(upstreamRequests[1].tools[0].function.name, 'exec');
    assert.equal(body.output[0].type, 'custom_tool_call');
    assert.equal(body.output[0].name, 'exec');
    assert.equal(body.output[0].input, 'pwd');
    assert.equal(traceEvents.some((event) => (
      event.type === 'request.adjusted'
      && event.adjustments?.some((adjustment: any) => adjustment.reason === 'upstream_rejected_forced_tool_choice')
    )), true);
    assert.equal(traceEvents.some((event) => event.type === 'upstream.retry' && event.status === 400), true);
  } finally {
    await server.stop();
  }
});

test('adapter server restores namespace tools from provider tool calls', async () => {
  const upstreamRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      return new Response(JSON.stringify({
        id: 'chatcmpl_namespace_loop',
        created: 1_700_000_411,
        model: 'namespace-loop-model',
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_open_file_1',
              type: 'function',
              function: {
                name: 'mcp__vscode_mcp__open_file',
                arguments: '{"path":"README.md"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'namespace-loop-model',
        input: 'open README',
        tools: [{
          type: 'namespace',
          name: 'mcp__vscode_mcp__',
          description: 'VS Code MCP tools.',
          tools: [{
            type: 'function',
            name: 'open_file',
            description: 'Open a file.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
              required: ['path'],
            },
          }],
        }],
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamRequests[0].tools.map((tool: any) => tool.function.name), ['mcp__vscode_mcp__open_file']);
    assert.equal(body.output[0].type, 'function_call');
    assert.equal(body.output[0].namespace, 'mcp__vscode_mcp__');
    assert.equal(body.output[0].name, 'open_file');
    assert.equal(body.output[0].arguments, '{"path":"README.md"}');
  } finally {
    await server.stop();
  }
});

test('adapter server completes an apply_patch proxy loop over Chat Completions', async () => {
  const upstreamRequests: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      upstreamRequests.push(requestBody);
      if (upstreamRequests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chatcmpl_patch_loop_1',
          created: 1_700_000_421,
          model: 'patch-loop-model',
          choices: [{
            message: {
              tool_calls: [{
                id: 'call_patch_1',
                type: 'function',
                function: {
                  name: 'apply_patch_add_file',
                  arguments: '{"path":"hello.txt","content":"hello"}',
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl_patch_loop_2',
        created: 1_700_000_422,
        model: 'patch-loop-model',
        choices: [{
          message: {
            content: 'patch result received',
          },
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const firstResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'patch-loop-model',
        input: 'add hello.txt',
        tools: [{
          type: 'custom',
          name: 'apply_patch',
          description: 'Patch files.',
        }],
      }),
    });
    const firstBody = await firstResponse.json() as any;
    assert.equal(firstResponse.status, 200);
    assert.deepEqual(upstreamRequests[0].tools.map((tool: any) => tool.function.name), [
      'apply_patch_add_file',
      'apply_patch_delete_file',
      'apply_patch_update_file',
      'apply_patch_replace_file',
      'apply_patch_batch',
    ]);
    assert.equal(firstBody.output[0].type, 'custom_tool_call');
    assert.equal(firstBody.output[0].name, 'apply_patch');
    assert.equal(firstBody.output[0].input, [
      '*** Begin Patch',
      '*** Add File: hello.txt',
      '+hello',
      '*** End Patch',
    ].join('\n'));

    const secondResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'patch-loop-model',
        input: [
          firstBody.output[0],
          {
            type: 'custom_tool_call_output',
            call_id: 'call_patch_1',
            output: 'Done!',
          },
        ],
        tools: [{
          type: 'custom',
          name: 'apply_patch',
        }],
      }),
    });
    const secondBody = await secondResponse.json() as any;
    assert.equal(secondResponse.status, 200);
    assert.equal(secondBody.output[0].content[0].text, 'patch result received');
    assert.equal(upstreamRequests[1].messages[0].tool_calls[0].function.name, 'apply_patch_add_file');
    assert.deepEqual(JSON.parse(upstreamRequests[1].messages[0].tool_calls[0].function.arguments), {
      path: 'hello.txt',
      content: 'hello',
    });
    assert.equal(upstreamRequests[1].messages[1].role, 'tool');
    assert.equal(upstreamRequests[1].messages[1].tool_call_id, 'call_patch_1');
    assert.equal(upstreamRequests[1].messages[1].content, 'Done!');
  } finally {
    await server.stop();
  }
});

test('adapter server associates usage with model pricing metadata', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    models: [{
      id: 'priced-model',
      pricing: {
        inputCostPerToken: 0.1,
        outputCostPerToken: 0.2,
      },
    }],
    fetchImpl: (async () => new Response(JSON.stringify({
      id: 'chatcmpl_priced_usage',
      created: 1_700_000_111,
      model: 'priced-model',
      choices: [{
        message: {
          content: 'priced server answer',
        },
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'priced-model',
        input: 'estimate this',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.deepEqual(body.usage.metadata.pricing, {
      inputCostPerToken: 0.1,
      outputCostPerToken: 0.2,
    });
    assert.deepEqual(body.usage.metadata.estimated_cost, {
      input_cost: 1,
      output_cost: 4,
      total_cost: 5,
    });
  } finally {
    await server.stop();
  }
});

test('adapter server preserves retry-after and rate-limit metadata for upstream HTTP errors', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => new Response(JSON.stringify({
      error: {
        message: 'Rate limit exceeded for deployment',
        type: 'rate_limit_error',
      },
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '12',
        'X-Request-Id': 'req_litellm_style_123',
        'X-MS-Region': 'eastus',
        'X-RateLimit-Remaining-Requests': '99',
        'X-RateLimit-Remaining-Tokens': '9999',
      },
    })) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        input: 'continue',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 429);
    assert.equal(body.error.message, 'Rate limit exceeded for deployment');
    assert.equal(body.error.type, 'rate_limit_error');
    assert.equal(body.error.code, 'rate_limit_exceeded');
    assert.equal(body.error.category, 'rate_limit');
    assert.equal(body.error.retry_after_ms, 12_000);
    assert.deepEqual(body.error.retry, {
      retryable: true,
      hint: 'respect_retry_after',
      retry_after_ms: 12_000,
    });
    assert.equal(body.error.metadata.request_id, 'req_litellm_style_123');
    assert.equal(body.error.metadata.region, 'eastus');
    assert.deepEqual(body.error.metadata.rate_limit_headers, {
      'x-ratelimit-remaining-requests': '99',
      'x-ratelimit-remaining-tokens': '9999',
    });
  } finally {
    await server.stop();
  }
});

test('adapter server categorizes authentication and unsupported-feature upstream errors', async () => {
  let calls = 0;
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          error: {
            message: 'Invalid API key provided',
            type: 'authentication_error',
          },
        }), {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }
      return new Response(JSON.stringify({
        error: {
          message: 'response_format is not supported for this model',
          type: 'invalid_request_error',
        },
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }) as typeof fetch,
  });

  await server.start();
  try {
    const authResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        input: 'auth case',
      }),
    });
    const authBody = await authResponse.json() as any;
    assert.equal(authResponse.status, 401);
    assert.equal(authBody.error.category, 'authentication');
    assert.deepEqual(authBody.error.retry, {
      retryable: false,
      hint: 'check_api_key_or_access',
    });

    const unsupportedResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        input: 'unsupported case',
      }),
    });
    const unsupportedBody = await unsupportedResponse.json() as any;
    assert.equal(unsupportedResponse.status, 400);
    assert.equal(unsupportedBody.error.category, 'unsupported_feature');
    assert.deepEqual(unsupportedBody.error.retry, {
      retryable: false,
      hint: 'remove_or_downgrade_unsupported_feature',
    });
  } finally {
    await server.stop();
  }
});

test('adapter server returns malformed-upstream taxonomy when a success payload cannot be adapted', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => new Response(JSON.stringify('bad-success-payload'), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'example-model',
        input: 'bad upstream payload',
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 502);
    assert.equal(body.error.code, 'malformed_upstream_payload');
    assert.equal(body.error.category, 'malformed_upstream');
    assert.deepEqual(body.error.retry, {
      retryable: true,
      hint: 'retry_or_inspect_upstream',
    });
  } finally {
    await server.stop();
  }
});

test('adapter server streams codex-proxy style event ordering and keeps previous_response_id', async () => {
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => createEventStreamResponse([
      {
        id: 'chatcmpl_stream_prev_turn',
        created: 1_700_000_102,
        model: 'stream-model',
        choices: [{
          index: 0,
          delta: {
            content: 'hello',
          },
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_stream_prev_1',
              function: {
                name: 'lookup',
                arguments: '{"q"',
              },
            }],
          },
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: {
                arguments: ':"x"}',
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7,
        },
      },
    ])) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'stream-model',
        previous_response_id: 'resp_parent_stream_1',
        input: 'continue stream',
        stream: true,
      }),
    });
    const text = await response.text();
    const events = parseSseText(text);
    const eventTypes = events.map((entry) => entry.event);

    const createdIndex = eventTypes.indexOf('response.created');
    const completedIndex = eventTypes.lastIndexOf('response.completed');
    const textDeltaIndex = eventTypes.indexOf('response.output_text.delta');
    const functionDeltaIndices = eventTypes
      .map((event, index) => event === 'response.function_call_arguments.delta' ? index : -1)
      .filter((index) => index >= 0);
    const outputDoneIndex = eventTypes.lastIndexOf('response.output_item.done');

    assert.equal(response.status, 200);
    assert.equal(createdIndex >= 0, true);
    assert.equal(textDeltaIndex > createdIndex, true);
    assert.equal(functionDeltaIndices.length >= 2, true);
    assert.equal(functionDeltaIndices[0] > textDeltaIndex, true);
    assert.equal(outputDoneIndex > functionDeltaIndices.at(-1), true);
    assert.equal(completedIndex > outputDoneIndex, true);

    const completedEvent = events.at(-1)?.data;
    assert.equal(completedEvent.response.previous_response_id, 'resp_parent_stream_1');
    assert.equal(completedEvent.response.output[1].type, 'function_call');
    assert.equal(completedEvent.response.output[1].arguments, '{"q":"x"}');
  } finally {
    await server.stop();
  }
});

test('adapter server stream parser preserves utf8 across byte chunk boundaries', async () => {
  const encoder = new TextEncoder();
  const payload = {
    id: 'chatcmpl_utf8',
    created: 1_700_000_230,
    model: 'utf8-model',
    choices: [{
      index: 0,
      delta: {
        content: '你好',
      },
      finish_reason: 'stop',
    }],
  };
  const sse = `data: ${JSON.stringify(payload)}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const split = encoder.encode(sse.slice(0, sse.indexOf('好'))).length + 1;
  const bytes = encoder.encode(sse);
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => createRawEventStreamResponse([
      bytes.slice(0, split),
      bytes.slice(split),
    ])) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'utf8-model',
        input: 'say hello',
        stream: true,
      }),
    });
    const text = await response.text();
    const events = parseSseText(text);
    assert.equal(response.status, 200);
    assert.equal(events.some((entry) => entry.event === 'response.output_text.delta' && entry.data.delta === '你好'), true);
    assert.equal(events.at(-1)?.data.response.output[0].content[0].text, '你好');
  } finally {
    await server.stop();
  }
});

test('adapter server stream parser maps upstream event error frames to Responses failure', async () => {
  const encoder = new TextEncoder();
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    fetchImpl: (async () => createRawEventStreamResponse([
      encoder.encode('event: error\ndata: {"message":"bad stream","code":"bad_stream"}\n\n'),
    ])) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'error-stream-model',
        input: 'stream',
        stream: true,
      }),
    });
    const text = await response.text();
    const events = parseSseText(text);
    const failed = events.find((entry) => entry.event === 'response.failed')?.data;
    assert.equal(response.status, 200);
    assert.equal(failed.response.status, 'failed');
    assert.equal(failed.response.error.message, 'bad stream');
    assert.equal(failed.response.error.code, 'bad_stream');
  } finally {
    await server.stop();
  }
});

test('adapter server trace sink captures translated streaming events', async () => {
  const events: any[] = [];
  const server = new OpenAICompatibleResponsesAdapterServer({
    apiKey: 'test-key',
    traceSink: (event) => {
      events.push(JSON.parse(JSON.stringify(event)));
    },
    fetchImpl: (async () => createEventStreamResponse([
      {
        id: 'chatcmpl_trace_stream',
        created: 1_700_000_220,
        model: 'trace-stream-model',
        choices: [{
          index: 0,
          delta: {
            content: 'hello',
          },
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 1,
          total_tokens: 3,
        },
      },
    ])) as typeof fetch,
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'trace-stream-model',
        input: 'stream this request',
        stream: true,
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(body.includes('response.completed'), true);
    assert.equal(events[0].type, 'request.received');
    assert.equal(events[1].type, 'request.translated');
    assert.equal(events.some((event) => event.type === 'stream.event' && event.event.type === 'response.output_text.delta'), true);
    const completed = events.find((event) => event.type === 'stream.completed');
    assert.equal(Boolean(completed), true);
    assert.equal(completed.eventCount >= 3, true);
  } finally {
    await server.stop();
  }
});
