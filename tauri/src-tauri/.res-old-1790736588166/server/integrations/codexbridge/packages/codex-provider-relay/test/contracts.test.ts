import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  chatCompletionsResponseToResponses,
  responsesRequestToChatCompletions,
  responsesRequestToCompactionResponse,
  translateChatCompletionsSseStreamToResponsesSse,
  translateChatCompletionsSseToResponsesEvents,
} from '../src/index.js';

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

test('contract: Responses request converts to Chat request without bridge-owned fields', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'contract-model',
    instructions: 'Return JSON only.',
    input: 'Summarize this.',
    max_output_tokens: 2048,
    temperature: 0.2,
    stream: true,
    user: 'weixin-scope-hidden-from-package',
    text: {
      format: {
        type: 'json_schema',
        name: 'summary',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
          },
          required: ['summary'],
        },
      },
    },
  });

  assert.equal(chat.model, 'contract-model');
  assert.equal(chat.stream, true);
  assert.equal(chat.max_tokens, 2048);
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'Return JSON only.' },
    { role: 'user', content: 'Summarize this.' },
  ]);
  assert.equal(chat.response_format.type, 'json_schema');
  assert.equal(chat.response_format.json_schema.name, 'summary');
  assert.equal(chat.response_format.json_schema.strict, true);
  assert.equal(chat.user, 'weixin-scope-hidden-from-package');
  assert.equal('sendgate' in chat, false);
  assert.equal('platform' in chat, false);
});

test('contract: non-streaming Chat response converts to a completed Responses object', () => {
  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_contract',
    created: 1_700_000_000,
    model: 'provider-model',
    choices: [{
      message: {
        content: 'final answer',
      },
    }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
  }, {
    request: {
      model: 'contract-model',
      instructions: 'Be concise.',
      input: 'Question',
      parallel_tool_calls: false,
      text: { format: { type: 'text' } },
    },
  });

  assert.equal(response.id, 'chatcmpl_contract');
  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.model, 'contract-model');
  assert.equal(response.instructions, 'Be concise.');
  assert.equal(response.parallel_tool_calls, false);
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].status, 'completed');
  assert.equal(response.output[0].content[0].type, 'output_text');
  assert.equal(response.output[0].content[0].text, 'final answer');
  assert.equal(response.usage.input_tokens, 11);
  assert.equal(response.usage.output_tokens, 7);
  assert.equal(response.usage.total_tokens, 18);
});

test('contract: function tools convert in request and restore names in non-streaming output', () => {
  const longToolName = 'mcp__workspace_namespace_with_many_segments__search_records_with_a_very_long_name';
  const request = {
    model: 'tool-model',
    input: [{
      type: 'function_call',
      call_id: 'call_1',
      name: longToolName,
      arguments: '{"query":"alpha"}',
    }, {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'result text',
    }],
    tools: [{
      type: 'function',
      name: longToolName,
      description: 'Search records.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
      },
    }],
    tool_choice: {
      type: 'function',
      name: longToolName,
    },
  };
  const chat = responsesRequestToChatCompletions(request);
  const shortenedName = chat.tools[0].function.name;

  assert.equal(shortenedName.length <= 64, true);
  assert.equal(chat.messages[0].role, 'assistant');
  assert.equal(chat.messages[0].tool_calls[0].function.name, shortenedName);
  assert.equal(chat.messages[1].role, 'tool');
  assert.equal(chat.tool_choice.function.name, shortenedName);

  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_tool',
    created: 1_700_000_001,
    choices: [{
      message: {
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: {
            name: shortenedName,
            arguments: '{"query":"beta"}',
          },
        }],
      },
    }],
  }, {
    request,
  });

  assert.equal(response.output[0].type, 'function_call');
  assert.equal(response.output[0].call_id, 'call_2');
  assert.equal(response.output[0].name, longToolName);
  assert.equal(response.output[0].arguments, '{"query":"beta"}');
});

test('contract: tool-disabled models downgrade tool transcript instead of forwarding tools', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'no-tools',
    input: [{
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"q":"x"}',
    }, {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'lookup result',
    }],
    tools: [{
      type: 'function',
      name: 'lookup',
      parameters: { type: 'object' },
    }],
    tool_choice: {
      type: 'function',
      name: 'lookup',
    },
  }, {
    providerCapabilities: {
      modelCapabilities: {
        'no-tools': {
          tools: false,
        },
      },
    },
  });

  assert.equal(chat.tools, undefined);
  assert.equal(chat.tool_choice, undefined);
  assert.equal(chat.messages[0].role, 'assistant');
  assert.match(chat.messages[0].content, /Tool call omitted/);
  assert.equal(chat.messages[1].role, 'user');
  assert.match(chat.messages[1].content, /Tool output omitted/);
});

test('contract: streaming text and tool-call chunks produce Responses SSE events', () => {
  const events = translateChatCompletionsSseToResponsesEvents(readNdjsonFixture('stream-openai-tool-call.ndjson'), {
    request: {
      model: 'stream-model',
    },
  });

  assert.equal(events[0].type, 'response.created');
  assert.equal(events[1].type, 'response.in_progress');
  assert.equal(events.some((event) => event.type === 'response.output_text.delta' && event.delta === 'hello'), true);
  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.delta' && event.delta === '{"q"'), true);
  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.delta' && event.delta === ':"x"}'), true);
  const completed = events.at(-1)?.response;
  assert.equal(events.at(-1)?.type, 'response.completed');
  assert.equal(completed.output[0].type, 'message');
  assert.equal(completed.output[0].content[0].text, 'hello');
  assert.equal(completed.output[1].type, 'function_call');
  assert.equal(completed.output[1].call_id, 'call_stream_1');
  assert.equal(completed.output[1].arguments, '{"q":"x"}');
  assert.equal(completed.usage.input_tokens, 4);
  assert.equal(completed.usage.output_tokens, 3);
  assert.equal(completed.usage.total_tokens, 7);
});

test('contract: usage maps OpenAI usage, Gemini usageMetadata, and estimates when enabled', () => {
  const openaiUsage = chatCompletionsResponseToResponses({
    choices: [{ message: { content: 'ok' } }],
    usage: {
      prompt_tokens: 2,
      completion_tokens: 5,
      total_tokens: 7,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 2,
      reasoning_tokens: 3,
      output_audio_tokens: 4,
      accepted_prediction_tokens: 5,
      rejected_prediction_tokens: 6,
    },
  });
  assert.equal(openaiUsage.usage.total_tokens, 7);
  assert.equal(openaiUsage.usage.input_tokens_details.cached_tokens, 1);
  assert.equal(openaiUsage.usage.input_tokens_details.cache_creation_tokens, 2);
  assert.equal(openaiUsage.usage.output_tokens_details.reasoning_tokens, 3);
  assert.equal(openaiUsage.usage.output_tokens_details.audio_tokens, 4);
  assert.equal(openaiUsage.usage.output_tokens_details.accepted_prediction_tokens, 5);
  assert.equal(openaiUsage.usage.output_tokens_details.rejected_prediction_tokens, 6);

  const geminiUsage = chatCompletionsResponseToResponses(readJsonFixture('response-gemini-usage.json'));
  assert.equal(geminiUsage.usage.input_tokens, 2);
  assert.equal(geminiUsage.usage.output_tokens, 4);
  assert.equal(geminiUsage.usage.input_tokens_details.cached_tokens, 1);
  assert.equal(geminiUsage.usage.output_tokens_details.reasoning_tokens, 2);

  const estimatedUsage = chatCompletionsResponseToResponses({
    choices: [{ message: { content: 'estimated output' } }],
  }, {
    request: {
      model: 'estimate-model',
      input: 'estimate input',
    },
    providerCapabilities: {
      usage: {
        estimateWhenMissing: true,
      },
    },
  });
  assert.equal(estimatedUsage.usage.total_tokens > 0, true);
});

test('contract: usage metadata can associate normalized pricing with estimated response cost', () => {
  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_usage_cost',
    created: 1_700_000_004,
    model: 'priced-model',
    choices: [{
      message: {
        content: 'priced answer',
      },
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
  }, {
    request: {
      model: 'priced-model',
      input: 'hello',
    },
    modelMetadata: {
      pricing: {
        inputCostPerToken: 0.1,
        output_cost_per_token: 0.2,
      },
    },
  });

  assert.deepEqual(response.usage.metadata.pricing, {
    inputCostPerToken: 0.1,
    outputCostPerToken: 0.2,
  });
  assert.deepEqual(response.usage.metadata.estimated_cost, {
    input_cost: 1,
    output_cost: 4,
    total_cost: 5,
  });
});

test('contract: upstream stream errors and read failures become Responses failures', async () => {
  const topLevelErrorEvents = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify(readJsonFixture('error-openai-rate-limit.json')),
  ], {
    request: {
      model: 'error-model',
    },
  });
  assert.equal(topLevelErrorEvents.at(-1)?.type, 'response.failed');
  assert.equal(topLevelErrorEvents.at(-1)?.response.status, 'failed');
  assert.equal(topLevelErrorEvents.at(-1)?.response.error.code, 'rate_limit_exceeded');

  async function* failingStream() {
    yield JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          content: 'partial',
        },
      }],
    });
    throw new Error('socket closed');
  }

  const chunks: string[] = [];
  for await (const chunk of translateChatCompletionsSseStreamToResponsesSse(failingStream(), {
    request: {
      model: 'error-model',
    },
  })) {
    chunks.push(chunk);
  }
  const payloads = chunks
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)));
  const failed = payloads.find((payload) => payload.type === 'response.failed');
  assert.equal(failed.response.status, 'failed');
  assert.equal(failed.response.error.message, 'socket closed');
  assert.equal(chunks.at(-1), 'data: [DONE]\n\n');
});

test('contract: compact fallback produces a Responses compaction object', () => {
  const response = responsesRequestToCompactionResponse({
    model: 'compact-model',
    input: [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: 'keep this',
      }],
    }],
  }, {
    responseId: 'resp_compact_contract',
    createdAt: 1_700_000_003,
    providerCapabilities: {
      usage: {
        estimateWhenMissing: true,
      },
    },
  });

  assert.equal(response.id, 'resp_compact_contract');
  assert.equal(response.object, 'response.compaction');
  assert.equal(response.created_at, 1_700_000_003);
  assert.equal(response.output[0].type, 'message');
  assert.equal(response.output[0].content[0].text, 'keep this');
  assert.equal(response.usage.total_tokens > 0, true);
});

test('contract: multimodal capability downgrades unsupported image and file input', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'text-only',
    input: [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: 'Analyze these attachments.',
      }, {
        type: 'input_image',
        image_url: 'data:image/png;base64,abc',
      }, {
        type: 'input_file',
        file_data: 'data:application/pdf;base64,abc',
        filename: 'report.pdf',
      }],
    }],
  }, {
    providerCapabilities: {
      modelCapabilities: {
        'text-only': {
          vision: false,
          fileInput: false,
        },
      },
    },
  });

  assert.equal(typeof chat.messages[0].content, 'string');
  assert.match(chat.messages[0].content, /Analyze these attachments/);
  assert.match(chat.messages[0].content, /Unsupported image input omitted/);
  assert.match(chat.messages[0].content, /Unsupported file input omitted: report\.pdf/);
});

function readJsonFixture(fileName: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, fileName), 'utf8'));
}

function readNdjsonFixture(fileName: string): string[] {
  return fs.readFileSync(path.join(FIXTURES_DIR, fileName), 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}
