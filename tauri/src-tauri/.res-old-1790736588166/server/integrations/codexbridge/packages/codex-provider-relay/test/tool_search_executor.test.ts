import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodexProviderRelayToolSearchExecutor,
  type CodexProviderRelayToolSearchExecutorContent,
} from '../src/index.js';

function baseRequest(argumentsValue: Record<string, any>) {
  return {
    toolName: 'tool_search' as const,
    relayToolName: 'relay_tool_search',
    callId: 'call_tool_search_1',
    arguments: argumentsValue,
    rawArguments: JSON.stringify(argumentsValue),
    model: 'example-model',
    providerKind: 'openai-compatible',
    providerName: 'Example',
  };
}

test('tool_search executor returns matching static function tools', async () => {
  const executor = createCodexProviderRelayToolSearchExecutor({
    tools: [{
      type: 'function',
      name: 'lookup_docs',
      description: 'Look up project documentation.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    }, {
      type: 'function',
      name: 'create_invoice',
      description: 'Create billing invoices.',
      parameters: {
        type: 'object',
        properties: {},
      },
    }],
  });

  const result = await executor(baseRequest({
    query: 'documentation',
  }));
  const content = result.content as CodexProviderRelayToolSearchExecutorContent;

  assert.equal(content.query, 'documentation');
  assert.equal(content.tools.length, 1);
  assert.equal(content.tools[0].function.name, 'lookup_docs');
  assert.equal(content.tools[0].function.parameters.required[0], 'query');
  assert.equal(result.metadata?.toolCount, 1);
});

test('tool_search executor supports request-level tools and namespaces', async () => {
  const executor = createCodexProviderRelayToolSearchExecutor({
    maxResults: 5,
  });

  const result = await executor(baseRequest({
    goal: 'search the workspace',
    available_tools: [{
      name: 'search_workspace',
      description: 'Search files in the workspace.',
    }],
    namespaces: [{
      name: 'docs',
      description: 'Search documentation tools.',
      tools: [{
        name: 'summarize',
        description: 'Summarize documentation pages.',
      }],
    }],
  }));
  const content = result.content as CodexProviderRelayToolSearchExecutorContent;

  assert.equal(content.goal, 'search the workspace');
  assert.equal(content.tools[0].function.name, 'search_workspace');
  assert.equal(content.namespaces[0].name, 'docs');
  assert.equal(content.namespaces[0].tools[0].function.name, 'summarize');
});

test('tool_search executor can delegate discovery to a custom resolver', async () => {
  const seen: any[] = [];
  const executor = createCodexProviderRelayToolSearchExecutor({
    search(request) {
      seen.push(JSON.parse(JSON.stringify({
        query: request.query,
        goal: request.goal,
        maxResults: request.maxResults,
      })));
      return {
        tools: [{
          type: 'function',
          function: {
            name: 'resolved_tool',
            description: 'Returned by resolver.',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        }],
        metadata: {
          source: 'resolver',
        },
      };
    },
  });

  const result = await executor(baseRequest({
    query: 'resolved',
    goal: 'use custom resolver',
    max_results: 1,
  }));
  const content = result.content as CodexProviderRelayToolSearchExecutorContent;

  assert.deepEqual(seen[0], {
    query: 'resolved',
    goal: 'use custom resolver',
    maxResults: 1,
  });
  assert.equal(content.tools[0].function.name, 'resolved_tool');
  assert.equal(result.metadata?.source, 'resolver');
});
