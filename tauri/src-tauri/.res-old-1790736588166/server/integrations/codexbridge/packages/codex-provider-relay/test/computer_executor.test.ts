import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodexProviderRelayComputerExecutor,
  type CodexProviderRelayComputerExecutorContent,
} from '../src/index.js';

function baseRequest(argumentsValue: Record<string, any>) {
  return {
    toolName: 'computer' as const,
    relayToolName: 'relay_computer',
    callId: 'call_computer_1',
    arguments: argumentsValue,
    rawArguments: JSON.stringify(argumentsValue),
    model: 'example-model',
    providerKind: 'openai-compatible',
    providerName: 'Example',
  };
}

test('computer executor sends normalized actions and display to provider', async () => {
  const seen: any[] = [];
  const executor = createCodexProviderRelayComputerExecutor({
    async execute(request) {
      seen.push(JSON.parse(JSON.stringify({
        actions: request.actions,
        display: request.display,
        toolName: request.toolRequest.toolName,
      })));
      return {
        screenshot: {
          b64_png: 'aW1hZ2U=',
          detail: 'high',
        },
        observations: ['Clicked button', 'Captured screenshot'],
        metadata: {
          sandbox: 'unit-test',
        },
      };
    },
  });

  const result = await executor(baseRequest({
    actions: [{
      type: 'click',
      x: 10,
      y: 20,
      button: 'left',
    }, {
      type: 'keypress',
      keys: ['CTRL', 'L'],
    }, {
      type: 'drag',
      path: [{ x: 1, y: 1 }, { x: 5, y: 5 }],
    }, {
      type: 'screenshot',
    }],
    display: {
      width: 1280,
      height: 720,
      environment: 'browser',
    },
  }));
  const content = result.content as CodexProviderRelayComputerExecutorContent;

  assert.deepEqual(seen[0], {
    actions: [{
      type: 'click',
      x: 10,
      y: 20,
      button: 'left',
    }, {
      type: 'keypress',
      keys: ['CTRL', 'L'],
    }, {
      type: 'drag',
      path: [{ x: 1, y: 1 }, { x: 5, y: 5 }],
    }, {
      type: 'screenshot',
    }],
    display: {
      width: 1280,
      height: 720,
      environment: 'browser',
    },
    toolName: 'computer',
  });
  assert.equal(content.screenshot?.b64_png, 'aW1hZ2U=');
  assert.equal(content.screenshot?.detail, 'high');
  assert.deepEqual(content.observations, ['Clicked button', 'Captured screenshot']);
  assert.equal(result.metadata?.actionCount, 4);
  assert.equal(result.metadata?.hasScreenshot, true);
  assert.equal(result.metadata?.sandbox, 'unit-test');
});

test('computer executor supports single action object arguments', async () => {
  const seen: any[] = [];
  const executor = createCodexProviderRelayComputerExecutor({
    execute(request) {
      seen.push(request.actions);
      return {
        observations: ['moved'],
      };
    },
  });

  await executor(baseRequest({
    type: 'move',
    x: 5,
    y: 6,
  }));

  assert.deepEqual(seen[0], [{
    type: 'move',
    x: 5,
    y: 6,
  }]);
});

test('computer executor requires an explicit sandbox provider', () => {
  assert.throws(() => createCodexProviderRelayComputerExecutor({} as any), /requires an explicit/u);
});
