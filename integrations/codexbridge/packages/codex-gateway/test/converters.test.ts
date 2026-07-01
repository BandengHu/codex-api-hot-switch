import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatCompletionsResponseToResponses,
  responsesRequestToChatCompletions,
  translateChatCompletionsSseToResponsesEvents,
} from '../src/index.js';

test('responses request conversion is available from the package boundary', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5.4',
    instructions: 'be concise',
    input: 'hello',
    text: {
      format: {
        type: 'json_schema',
        name: 'answer',
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
      },
    },
  });

  assert.equal(chat.model, 'gpt-5.4');
  assert.equal(chat.messages[0].role, 'system');
  assert.equal(chat.messages[1].role, 'user');
  assert.equal(chat.response_format.type, 'json_schema');
});

test('chat response conversion is available from the package boundary', () => {
  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_test',
    created: 1234,
    model: 'example-model',
    choices: [{
      message: {
        content: 'done',
      },
    }],
    usage: {
      prompt_tokens: 2,
      completion_tokens: 3,
      total_tokens: 5,
    },
  });

  assert.equal(response.id, 'chatcmpl_test');
  assert.equal(response.model, 'example-model');
  assert.equal(response.output[0].content[0].text, 'done');
  assert.equal(response.usage.total_tokens, 5);
});

test('chat SSE conversion is available from the package boundary', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      id: 'chatcmpl_stream',
      created: 1234,
      model: 'example-model',
      choices: [{
        index: 0,
        delta: {
          content: 'hi',
        },
      }],
    }),
    JSON.stringify({
      id: 'chatcmpl_stream',
      created: 1234,
      model: 'example-model',
      choices: [{
        index: 0,
        finish_reason: 'stop',
      }],
    }),
  ], {
    request: {
      model: 'example-model',
    },
  });

  assert.equal(events[0].type, 'response.created');
  assert.equal(events.some((event) => event.type === 'response.output_text.delta'), true);
  assert.equal(events.at(-1)?.type, 'response.completed');
});
