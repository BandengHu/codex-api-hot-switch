import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createResponsesWebSocketToolRepairCache,
  normalizeResponsesWebSocketRequest,
  recordResponsesWebSocketToolCallsFromEvent,
  repairResponsesWebSocketToolCalls,
  shouldReplaceResponsesWebSocketTranscript,
} from '../../../src/providers/openai_compatible/responses_websocket_repair.js';

test('normalizeResponsesWebSocketRequest normalizes the initial response.create request', () => {
  const result = normalizeResponsesWebSocketRequest({
    type: 'response.create',
    model: 'test-model',
    stream: false,
  });

  assert.equal(result.mode, 'initial');
  assert.equal(result.request.type, undefined);
  assert.equal(result.request.model, 'test-model');
  assert.equal(result.request.stream, true);
  assert.deepEqual(result.request.input, []);
});

test('normalizeResponsesWebSocketRequest merges follow-up input with previous request and response output', () => {
  const lastRequest = {
    model: 'test-model',
    instructions: 'stay concise',
    stream: true,
    input: [{ type: 'message', id: 'msg-1', role: 'user' }],
  };
  const result = normalizeResponsesWebSocketRequest({
    type: 'response.create',
    input: [{ type: 'message', id: 'msg-2', role: 'user' }],
  }, {
    lastRequest,
    lastResponseOutput: [{ type: 'message', id: 'assistant-1', role: 'assistant' }],
  });

  assert.equal(result.mode, 'merge');
  assert.equal(result.request.type, undefined);
  assert.equal(result.request.previous_response_id, undefined);
  assert.equal(result.request.model, 'test-model');
  assert.equal(result.request.instructions, 'stay concise');
  assert.equal(result.request.stream, true);
  assert.deepEqual(result.request.input.map((item: any) => item.id), ['msg-1', 'assistant-1', 'msg-2']);
});

test('normalizeResponsesWebSocketRequest treats post-compact function-call transcript as replacement', () => {
  const lastRequest = {
    model: 'test-model',
    stream: true,
    input: [
      { type: 'message', id: 'msg-1', role: 'user' },
      { type: 'function_call', id: 'fc-1', call_id: 'call-1' },
      { type: 'function_call_output', id: 'tool-out-1', call_id: 'call-1' },
      { type: 'message', id: 'assistant-1', role: 'assistant' },
    ],
  };
  const raw = {
    type: 'response.create',
    input: [
      { type: 'function_call', id: 'fc-compact', call_id: 'call-1', name: 'tool' },
      { type: 'message', id: 'msg-2', role: 'user' },
    ],
  };

  assert.equal(shouldReplaceResponsesWebSocketTranscript(raw), true);
  const result = normalizeResponsesWebSocketRequest(raw, {
    lastRequest,
    lastResponseOutput: [{ type: 'message', id: 'assistant-1', role: 'assistant' }],
  });

  assert.equal(result.mode, 'transcript-replacement');
  assert.equal(result.request.previous_response_id, undefined);
  assert.deepEqual(result.request.input.map((item: any) => item.id), ['fc-compact', 'msg-2']);
});

test('normalizeResponsesWebSocketRequest does not treat developer messages as transcript replacement', () => {
  const result = normalizeResponsesWebSocketRequest({
    type: 'response.create',
    input: [
      { type: 'message', id: 'dev-1', role: 'developer' },
      { type: 'message', id: 'msg-2', role: 'user' },
    ],
  }, {
    lastRequest: {
      model: 'test-model',
      stream: true,
      input: [{ type: 'message', id: 'msg-1', role: 'user' }],
    },
    lastResponseOutput: [{ type: 'message', id: 'assistant-1', role: 'assistant' }],
  });

  assert.equal(result.mode, 'merge');
  assert.deepEqual(result.request.input.map((item: any) => item.id), ['msg-1', 'assistant-1', 'dev-1', 'msg-2']);
});

test('normalizeResponsesWebSocketRequest preserves previous_response_id for incremental websocket mode', () => {
  const result = normalizeResponsesWebSocketRequest({
    type: 'response.create',
    previous_response_id: 'resp-1',
    input: [{ type: 'function_call_output', id: 'tool-out-1', call_id: 'call-1' }],
  }, {
    allowIncrementalInputWithPreviousResponseID: true,
    lastRequest: {
      model: 'test-model',
      instructions: 'keep going',
      stream: true,
      input: [{ type: 'message', id: 'msg-1' }],
    },
  });

  assert.equal(result.mode, 'incremental');
  assert.equal(result.request.previous_response_id, 'resp-1');
  assert.equal(result.request.model, 'test-model');
  assert.equal(result.request.instructions, 'keep going');
  assert.deepEqual(result.request.input.map((item: any) => item.id), ['tool-out-1']);
});

test('normalizeResponsesWebSocketRequest expands previous_response_id when incremental mode is disabled', () => {
  const result = normalizeResponsesWebSocketRequest({
    type: 'response.create',
    previous_response_id: 'resp-1',
    input: [{ type: 'message', id: 'msg-2', role: 'user' }],
  }, {
    allowIncrementalInputWithPreviousResponseID: false,
    lastRequest: {
      model: 'test-model',
      stream: true,
      input: [{ type: 'message', id: 'msg-1', role: 'user' }],
    },
    lastResponseOutput: [{ type: 'message', id: 'assistant-1', role: 'assistant' }],
  });

  assert.equal(result.mode, 'merge');
  assert.equal(result.request.previous_response_id, undefined);
  assert.deepEqual(result.request.input.map((item: any) => item.id), ['msg-1', 'assistant-1', 'msg-2']);
});

test('normalizeResponsesWebSocketRequest drops duplicate function calls by call_id during merge', () => {
  const result = normalizeResponsesWebSocketRequest({
    type: 'response.create',
    input: [{ type: 'message', id: 'msg-2', role: 'user' }],
  }, {
    lastRequest: {
      model: 'test-model',
      stream: true,
      input: [
        { type: 'function_call', id: 'fc-1', call_id: 'call-1' },
        { type: 'function_call_output', id: 'tool-out-1', call_id: 'call-1' },
      ],
    },
    lastResponseOutput: [
      { type: 'function_call', id: 'fc-dup', call_id: 'call-1', name: 'tool' },
    ],
  });

  assert.deepEqual(result.request.input.map((item: any) => item.id), ['fc-1', 'tool-out-1', 'msg-2']);
});

test('repairResponsesWebSocketToolCalls inserts cached output after a matching tool call', () => {
  const cache = createResponsesWebSocketToolRepairCache();
  const warmed = repairResponsesWebSocketToolCalls({
    previous_response_id: 'resp-1',
    input: [{ type: 'function_call_output', id: 'tool-out-1', call_id: 'call-1', output: 'ok' }],
  }, cache);
  assert.deepEqual(warmed.input.map((item: any) => item.id), ['tool-out-1']);

  const repaired = repairResponsesWebSocketToolCalls({
    input: [
      { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'tool' },
      { type: 'message', id: 'msg-1', role: 'user' },
    ],
  }, cache);

  assert.deepEqual(repaired.input.map((item: any) => item.id), ['fc-1', 'tool-out-1', 'msg-1']);
});

test('repairResponsesWebSocketToolCalls inserts cached call before a matching tool output', () => {
  const cache = createResponsesWebSocketToolRepairCache();
  recordResponsesWebSocketToolCallsFromEvent(cache, {
    type: 'response.output_item.done',
    item: { type: 'custom_tool_call', id: 'ctc-1', call_id: 'call-1', name: 'apply_patch' },
  });

  const repaired = repairResponsesWebSocketToolCalls({
    input: [
      { type: 'custom_tool_call_output', id: 'tool-out-1', call_id: 'call-1', output: 'ok' },
      { type: 'message', id: 'msg-1', role: 'user' },
    ],
  }, cache);

  assert.deepEqual(repaired.input.map((item: any) => item.id), ['ctc-1', 'tool-out-1', 'msg-1']);
});

test('repairResponsesWebSocketToolCalls drops orphaned tool calls and outputs without cache support', () => {
  const repaired = repairResponsesWebSocketToolCalls({
    input: [
      { type: 'function_call_output', id: 'tool-out-1', call_id: 'call-1', output: 'ok' },
      { type: 'function_call', id: 'fc-2', call_id: 'call-2', name: 'tool' },
      { type: 'message', id: 'msg-1', role: 'user' },
    ],
  });

  assert.deepEqual(repaired.input.map((item: any) => item.id), ['msg-1']);
});
