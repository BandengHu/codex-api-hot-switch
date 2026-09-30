import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodexProviderRelayCodeInterpreterExecutor,
  type CodexProviderRelayCodeInterpreterExecutorContent,
} from '../src/index.js';

function baseRequest(argumentsValue: Record<string, any>) {
  return {
    toolName: 'code_interpreter' as const,
    relayToolName: 'relay_code_interpreter',
    callId: 'call_code_1',
    arguments: argumentsValue,
    rawArguments: JSON.stringify(argumentsValue),
    model: 'example-model',
    providerKind: 'openai-compatible',
    providerName: 'Example',
  };
}

test('code_interpreter executor sends normalized execution request to provider', async () => {
  const seen: any[] = [];
  const executor = createCodexProviderRelayCodeInterpreterExecutor({
    async execute(request) {
      seen.push(JSON.parse(JSON.stringify({
        code: request.code,
        language: request.language,
        container: request.container,
        files: request.files,
        toolName: request.toolRequest.toolName,
      })));
      return {
        stdout: '3\n',
        stderr: '',
        result: { value: 3 },
        files: [{
          filename: 'plot.png',
          mime_type: 'image/png',
          b64_data: 'aW1hZ2U=',
        }],
        metadata: {
          sandbox: 'unit-test',
        },
      };
    },
  });

  const result = await executor(baseRequest({
    code: 'print(1 + 2)',
    language: 'python',
    container: {
      type: 'auto',
      memory_limit: '512mb',
    },
    files: [{
      file_id: 'file_1',
      filename: 'input.txt',
      content: 'hello',
    }],
  }));
  const content = result.content as CodexProviderRelayCodeInterpreterExecutorContent;

  assert.deepEqual(seen[0], {
    code: 'print(1 + 2)',
    language: 'python',
    container: {
      type: 'auto',
      memory_limit: '512mb',
    },
    files: [{
      file_id: 'file_1',
      filename: 'input.txt',
      content: 'hello',
    }],
    toolName: 'code_interpreter',
  });
  assert.equal(content.stdout, '3');
  assert.deepEqual(content.result, { value: 3 });
  assert.equal(content.files[0].filename, 'plot.png');
  assert.equal(result.metadata?.sandbox, 'unit-test');
  assert.equal(result.metadata?.fileCount, 1);
});

test('code_interpreter executor exposes stdout and stderr delta emitters', async () => {
  const deltas: any[] = [];
  const executor = createCodexProviderRelayCodeInterpreterExecutor({
    async execute(request) {
      await request.emitStdout('hello stdout\n', { step: 1 });
      await request.emitStderr('warning stderr\n', { step: 2 });
      return {
        stdout: 'hello stdout\n',
        stderr: 'warning stderr\n',
      };
    },
  });

  await executor({
    ...baseRequest({
      code: 'print("hello")',
    }),
    emitDelta: async (delta, metadata = null) => {
      deltas.push({ delta, metadata });
    },
  });

  assert.deepEqual(deltas[0], {
    delta: {
      type: 'code_interpreter.stream',
      stream: 'stdout',
      text: 'hello stdout',
    },
    metadata: {
      stream: 'stdout',
      step: 1,
    },
  });
  assert.deepEqual(deltas[1], {
    delta: {
      type: 'code_interpreter.stream',
      stream: 'stderr',
      text: 'warning stderr',
    },
    metadata: {
      stream: 'stderr',
      step: 2,
    },
  });
});

test('code_interpreter executor requires an explicit sandbox provider', () => {
  assert.throws(() => createCodexProviderRelayCodeInterpreterExecutor({} as any), /requires an explicit/u);
});
