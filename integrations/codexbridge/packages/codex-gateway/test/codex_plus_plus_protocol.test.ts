import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatCompletionsResponseToResponses,
  responsesRequestToChatCompletions,
  translateChatCompletionsSseToResponsesEvents,
} from '../src/index.js';
import {
  buildCustomToolCallHistory,
  reconstructApplyPatchInput,
} from '../src/converters/apply_patch_proxy.js';

test('codex++ port: request maps custom and namespace tools to Chat functions', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5-mini',
    input: 'open the file',
    tools: [{
      type: 'custom',
      name: 'exec',
      description: 'Run a command.',
    }, {
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
    tool_choice: {
      type: 'function',
      namespace: 'mcp__vscode_mcp__',
      name: 'open_file',
    },
    parallel_tool_calls: true,
  });

  const names = chat.tools.map((tool: any) => tool.function.name);
  assert.deepEqual(names, ['exec', 'mcp__vscode_mcp__open_file']);
  assert.equal(chat.tools[0].function.parameters.properties.input.type, 'string');
  assert.equal(chat.tools[1].function.description.includes('VS Code MCP tools.'), true);
  assert.equal(chat.tool_choice.function.name, 'mcp__vscode_mcp__open_file');
  assert.equal(chat.parallel_tool_calls, true);
});

test('codex++ port: request expands apply_patch custom tool into structured proxy tools', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5-mini',
    input: 'patch files',
    stream: true,
    tools: [{
      type: 'custom',
      name: 'apply_patch',
      description: 'Patch files.',
    }],
    tool_choice: {
      type: 'custom',
      name: 'apply_patch',
    },
  });

  const names = chat.tools.map((tool: any) => tool.function.name);
  assert.deepEqual(names, [
    'apply_patch_add_file',
    'apply_patch_delete_file',
    'apply_patch_update_file',
    'apply_patch_replace_file',
    'apply_patch_batch',
  ]);
  assert.equal(chat.tool_choice.function.name, 'apply_patch_batch');
  assert.equal(chat.stream_options.include_usage, true);
});

test('codex++ port: request applies CCS reasoning and tool-control edges', () => {
  const nonReasoning = responsesRequestToChatCompletions({
    model: 'gpt-4o',
    reasoning: { effort: 'high' },
    tool_choice: { type: 'required' },
    parallel_tool_calls: true,
    input: 'hi',
  });
  assert.equal(nonReasoning.reasoning_effort, undefined);
  assert.equal(nonReasoning.tool_choice, undefined);
  assert.equal(nonReasoning.parallel_tool_calls, undefined);

  const reasoning = responsesRequestToChatCompletions({
    model: 'gpt-5.4',
    reasoning: { effort: 'high' },
    tool_choice: { type: 'function', name: 'lookup' },
    input: 'hi',
  });
  assert.equal(reasoning.reasoning_effort, 'high');
  assert.equal(reasoning.tool_choice, undefined);

  const oSeries = responsesRequestToChatCompletions({
    model: 'o3-mini',
    max_output_tokens: 512,
    input: 'hi',
  });
  assert.equal(oSeries.max_completion_tokens, 512);
  assert.equal(oSeries.max_tokens, undefined);
});

test('codex++ port: request preserves instruction arrays and explicit max token aliases', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5.4',
    instructions: [
      { type: 'input_text', text: 'root instructions' },
      'extra policy',
      { text: 'final rule' },
    ],
    max_output_tokens: 512,
    max_tokens: 256,
    max_completion_tokens: 128,
    input: 'hi',
  });

  assert.equal(chat.messages[0].role, 'system');
  assert.equal(chat.messages[0].content, 'root instructions\n\nextra policy\n\nfinal rule');
  assert.equal(chat.max_tokens, 256);
  assert.equal(chat.max_completion_tokens, 128);
});

test('codex++ port: request applies CCSwitch reasoning dialect fallback by model name', () => {
  const deepseek = responsesRequestToChatCompletions({
    model: 'deepseek-reasoner',
    reasoning: { effort: 'xhigh' },
    input: 'hi',
  });
  assert.equal(deepseek.reasoning_effort, 'max');

  const openrouter = responsesRequestToChatCompletions({
    model: 'openrouter/deepseek/deepseek-r1',
    reasoning: { effort: 'max' },
    input: 'hi',
  });
  assert.equal(openrouter.reasoning.effort, 'xhigh');
  assert.equal(openrouter.reasoning_effort, undefined);

  const openrouterOff = responsesRequestToChatCompletions({
    model: 'openrouter/deepseek/deepseek-r1',
    reasoning: { effort: 'none' },
    input: 'hi',
  });
  assert.equal(openrouterOff.reasoning.effort, 'none');

  const kimi = responsesRequestToChatCompletions({
    model: 'kimi-k2-thinking',
    reasoning: { effort: 'high' },
    input: 'hi',
  });
  assert.deepEqual(kimi.thinking, { type: 'enabled' });
  assert.equal(kimi.reasoning_effort, undefined);

  const qwen = responsesRequestToChatCompletions({
    model: 'qwen3-coder-plus',
    reasoning: { effort: 'high' },
    input: 'hi',
  });
  assert.equal(qwen.enable_thinking, true);

  const minimaxOff = responsesRequestToChatCompletions({
    model: 'MiniMax-M2.7',
    reasoning: { effort: 'none' },
    input: 'hi',
  });
  assert.equal(minimaxOff.reasoning_split, false);
});

test('codex++ port: request replays custom apply_patch history as proxy tool call', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5-mini',
    input: [{
      type: 'custom_tool_call',
      call_id: 'call_patch',
      name: 'apply_patch',
      input: [
        '*** Begin Patch',
        '*** Add File: hello.txt',
        '+hello',
        '*** End Patch',
      ].join('\n'),
    }, {
      type: 'custom_tool_call_output',
      call_id: 'call_patch',
      output: 'Done',
    }],
    tools: [{
      type: 'custom',
      name: 'apply_patch',
    }],
  });

  assert.equal(chat.messages[0].role, 'assistant');
  assert.equal(chat.messages[0].tool_calls[0].id, 'call_patch');
  assert.equal(chat.messages[0].tool_calls[0].function.name, 'apply_patch_add_file');
  assert.deepEqual(JSON.parse(chat.messages[0].tool_calls[0].function.arguments), {
    path: 'hello.txt',
    content: 'hello',
  });
  assert.equal(chat.messages[1].role, 'tool');
  assert.equal(chat.messages[1].tool_call_id, 'call_patch');
  assert.equal(chat.messages[1].content, 'Done');
});

test('codex++ port: apply_patch proxy covers delete, update, replace, batch, and invalid arguments', () => {
  const deleteHistory = buildCustomToolCallHistory('apply_patch', [
    '*** Begin Patch',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n'));
  assert.equal(deleteHistory.name, 'apply_patch_delete_file');
  assert.deepEqual(JSON.parse(deleteHistory.arguments), {
    path: 'old.txt',
  });

  const updateHistory = buildCustomToolCallHistory('apply_patch', [
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '*** Move to: src/b.ts',
    '@@ function main',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n'));
  assert.equal(updateHistory.name, 'apply_patch_update_file');
  assert.deepEqual(JSON.parse(updateHistory.arguments), {
    path: 'src/a.ts',
    move_to: 'src/b.ts',
    hunks: [{
      header: 'function main',
      lines: ['-old', '+new'],
    }],
  });

  assert.equal(reconstructApplyPatchInput('delete_file', '{"path":"old.txt"}'), [
    '*** Begin Patch',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n'));

  assert.equal(reconstructApplyPatchInput('replace_file', '{"path":"next.txt","content":"one\\ntwo"}'), [
    '*** Begin Patch',
    '*** Delete File: next.txt',
    '*** Add File: next.txt',
    '+one',
    '+two',
    '*** End Patch',
  ].join('\n'));

  assert.equal(reconstructApplyPatchInput('batch', JSON.stringify({
    operations: [{
      type: 'add_file',
      path: 'new.txt',
      content: 'hello',
    }, {
      type: 'delete_file',
      path: 'old.txt',
    }],
  })), [
    '*** Begin Patch',
    '*** Add File: new.txt',
    '+hello',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n'));

  assert.equal(reconstructApplyPatchInput('add_file', '{not json'), '{not json');
});

test('codex++ port: request flattens namespace function-call history', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5-mini',
    input: [{
      type: 'function_call',
      call_id: 'call_ns',
      namespace: 'mcp__vscode_mcp__',
      name: 'open_file',
      arguments: '{"path":"README.md"}',
    }, {
      type: 'function_call_output',
      call_id: 'call_ns',
      output: 'opened',
    }],
    tools: [{
      type: 'namespace',
      name: 'mcp__vscode_mcp__',
      tools: [{
        type: 'function',
        name: 'open_file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
        },
      }],
    }],
  });

  assert.equal(chat.messages[0].tool_calls[0].function.name, 'mcp__vscode_mcp__open_file');
  assert.equal(chat.messages[1].tool_call_id, 'call_ns');
});

test('codex++ port: request collapses late system and developer messages to the head', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'MiniMax-M2.7',
    instructions: 'root system',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    }, {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'late developer' }],
    }, {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
    }],
  });

  assert.equal(chat.messages[0].role, 'system');
  assert.equal(chat.messages[0].content, 'root system\n\nlate developer');
  assert.equal(chat.messages.filter((message: any) => message.role === 'system').length, 1);
  assert.equal(chat.messages[1].role, 'user');
  assert.equal(chat.messages[2].role, 'assistant');
});

test('codex++ port: request maps latest_reminder to user role', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5-mini',
    input: [{
      type: 'message',
      role: 'latest_reminder',
      content: [{ type: 'input_text', text: 'remember this' }],
    }],
  });

  assert.equal(chat.messages[0].role, 'user');
  assert.equal(chat.messages[0].content, 'remember this');
});

test('codex++ port: request preserves reasoning content for thinking follow-up tool calls', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'deepseek-reasoner',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'use the tool' }],
    }, {
      id: 'rs_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Need to inspect files.' }],
    }, {
      type: 'function_call',
      call_id: 'call_1',
      name: 'shell',
      arguments: '{"cmd":"rg foo"}',
    }, {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'result',
    }],
  });

  assert.equal(chat.messages[1].role, 'assistant');
  assert.equal(chat.messages[1].reasoning_content, 'Need to inspect files.');
  assert.equal(chat.messages[1].tool_calls[0].id, 'call_1');
  assert.equal(chat.messages[2].role, 'tool');
});

test('codex++ port: request merges reasoning, assistant text, and following tool calls', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'deepseek-v4-pro',
    input: [{
      type: 'reasoning',
      status: 'completed',
      summary: [{ type: 'summary_text', text: 'I need to run go vet.' }],
    }, {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Let me run go vet.' }],
    }, {
      type: 'function_call',
      call_id: 'call_001',
      name: 'exec_command',
      arguments: '{"cmd":"go vet ./..."}',
    }, {
      type: 'function_call_output',
      call_id: 'call_001',
      output: 'no issues found',
    }, {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'run tests now' }],
    }],
  });

  assert.equal(chat.messages[0].role, 'assistant');
  assert.equal(chat.messages[0].content, 'Let me run go vet.');
  assert.equal(chat.messages[0].reasoning_content, 'I need to run go vet.');
  assert.equal(chat.messages[0].tool_calls[0].id, 'call_001');
  assert.equal(chat.messages[1].role, 'tool');
  assert.equal(chat.messages[1].tool_call_id, 'call_001');
  assert.equal(chat.messages[2].role, 'user');
});

test('codex++ port: request downgrades orphan tool outputs to user text', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5-mini',
    input: [{
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'I need the previous tool result.' }],
    }, {
      type: 'function_call_output',
      call_id: 'missing_call',
      output: 'tool output without a matching call',
    }, {
      type: 'custom_tool_call_output',
      call_id: 'missing_custom',
      output: 'custom output without a matching call',
    }],
  });

  assert.equal(chat.messages[0].role, 'assistant');
  assert.equal(chat.messages[0].tool_calls, undefined);
  assert.equal(chat.messages[1].role, 'user');
  assert.equal(chat.messages[1].content, 'Function call output (missing_call): tool output without a matching call');
  assert.equal(chat.messages[2].role, 'user');
  assert.equal(chat.messages[2].content, 'Function call output (missing_custom): custom output without a matching call');
});

test('codex++ port: request drops tool controls when no Chat tools survive', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5-mini',
    input: 'hi',
    tools: [{ type: 'unknown_builtin', name: 'unsupported' }],
    tool_choice: { type: 'required' },
    parallel_tool_calls: true,
  });

  assert.equal(chat.tools, undefined);
  assert.equal(chat.tool_choice, undefined);
  assert.equal(chat.parallel_tool_calls, undefined);
});

test('codex++ port: request normalizes function tool parameters', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5-mini',
    input: 'hi',
    tools: [{
      type: 'function',
      name: 'lookup',
      parameters: {},
    }],
  });

  assert.deepEqual(chat.tools[0].function.parameters, {
    type: 'object',
    properties: {},
    required: [],
  });
});

test('codex++ port: non-streaming response restores custom and namespace tool calls', () => {
  const request = {
    model: 'gpt-5-mini',
    input: 'run tools',
    tools: [{
      type: 'custom',
      name: 'exec',
    }, {
      type: 'namespace',
      name: 'mcp__vscode_mcp__',
      tools: [{
        type: 'function',
        name: 'open_file',
        parameters: { type: 'object' },
      }],
    }],
  };
  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_tools',
    choices: [{
      message: {
        tool_calls: [{
          id: 'call_custom',
          type: 'function',
          function: {
            name: 'exec',
            arguments: '{"input":"ls -la"}',
          },
        }, {
          id: 'call_ns',
          type: 'function',
          function: {
            name: 'mcp__vscode_mcp__open_file',
            arguments: '{"path":"README.md"}',
          },
        }],
      },
    }],
  }, {
    request,
  });

  assert.equal(response.output[0].type, 'custom_tool_call');
  assert.equal(response.output[0].name, 'exec');
  assert.equal(response.output[0].input, 'ls -la');
  assert.equal(response.output[1].type, 'function_call');
  assert.equal(response.output[1].namespace, 'mcp__vscode_mcp__');
  assert.equal(response.output[1].name, 'open_file');
});

test('codex++ port: non-streaming response reconstructs apply_patch proxy call', () => {
  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_patch',
    choices: [{
      message: {
        tool_calls: [{
          id: 'call_patch',
          type: 'function',
          function: {
            name: 'apply_patch_add_file',
            arguments: '{"path":"hello.txt","content":"hello"}',
          },
        }],
      },
    }],
  }, {
    request: {
      model: 'gpt-5-mini',
      input: 'patch files',
      tools: [{
        type: 'custom',
        name: 'apply_patch',
      }],
    },
  });

  assert.equal(response.output[0].type, 'custom_tool_call');
  assert.equal(response.output[0].name, 'apply_patch');
  assert.equal(response.output[0].input, [
    '*** Begin Patch',
    '*** Add File: hello.txt',
    '+hello',
    '*** End Patch',
  ].join('\n'));
});

test('codex++ port: non-streaming response extracts reasoning details', () => {
  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_reasoning_details',
    model: 'MiniMax-M2.7',
    choices: [{
      message: {
        reasoning_details: [
          { summary: 'Step one.' },
          { parts: [{ text: 'Step two.' }] },
        ],
        content: 'final',
      },
    }],
  });

  assert.equal(response.output[0].type, 'reasoning');
  assert.equal(response.output[0].reasoning_content, 'Step one.\n\nStep two.');
  assert.equal(response.output[0].summary[0].text, 'Step one.\n\nStep two.');
  assert.equal(response.output[1].type, 'message');
  assert.equal(response.output[1].content[0].text, 'final');
});

test('codex++ port: non-streaming response splits leading inline think block', () => {
  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_think',
    model: 'MiniMax-M2.7',
    choices: [{
      message: {
        content: '<think>\nNeed context.\n</think>\n\npong',
      },
    }],
  });

  assert.equal(response.output[0].type, 'reasoning');
  assert.equal(response.output[0].summary[0].text, 'Need context.');
  assert.equal(response.output[1].type, 'message');
  assert.equal(response.output[1].content[0].text, 'pong');
});

test('codex++ port: streaming response restores custom tool call with request context', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      id: 'chatcmpl_custom_stream',
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_custom',
            type: 'function',
            function: {
              name: 'exec',
            },
          }],
        },
      }],
    }),
    JSON.stringify({
      id: 'chatcmpl_custom_stream',
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              arguments: '{"input":"ls',
            },
          }],
        },
      }],
    }),
    JSON.stringify({
      id: 'chatcmpl_custom_stream',
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              arguments: ' -la"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
  ], {
    request: {
      model: 'gpt-5-mini',
      tools: [{
        type: 'custom',
        name: 'exec',
      }],
    },
  });

  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.delta'), false);
  assert.equal(events.some((event) => event.type === 'response.custom_tool_call_input.delta' && event.delta === 'ls -la'), true);
  const completed = events.at(-1)?.response;
  assert.equal(completed.output[0].type, 'custom_tool_call');
  assert.equal(completed.output[0].name, 'exec');
  assert.equal(completed.output[0].input, 'ls -la');
});

test('codex++ port: streaming response reconstructs apply_patch proxy call', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      id: 'chatcmpl_patch_stream',
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_patch',
            type: 'function',
            function: {
              name: 'apply_patch_add_file',
              arguments: '{"path":"hello.txt"',
            },
          }],
        },
      }],
    }),
    JSON.stringify({
      id: 'chatcmpl_patch_stream',
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              arguments: ',"content":"hello"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
  ], {
    request: {
      model: 'gpt-5-mini',
      tools: [{
        type: 'custom',
        name: 'apply_patch',
      }],
    },
  });

  const patch = [
    '*** Begin Patch',
    '*** Add File: hello.txt',
    '+hello',
    '*** End Patch',
  ].join('\n');
  assert.equal(events.some((event) => event.type === 'response.custom_tool_call_input.delta' && event.delta === patch), true);
  const completed = events.at(-1)?.response;
  assert.equal(completed.output[0].type, 'custom_tool_call');
  assert.equal(completed.output[0].name, 'apply_patch');
  assert.equal(completed.output[0].input, patch);
});

test('codex++ port: streaming response converts reasoning content before text', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      id: 'chatcmpl_reasoning',
      model: 'deepseek-reasoner',
      choices: [{
        delta: {
          reasoning_content: 'Need context. ',
        },
      }],
    }),
    JSON.stringify({
      id: 'chatcmpl_reasoning',
      model: 'deepseek-reasoner',
      choices: [{
        delta: {
          content: 'Done',
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 6,
        total_tokens: 10,
        completion_tokens_details: {
          reasoning_tokens: 3,
        },
      },
    }),
  ], {
    request: {
      model: 'deepseek-reasoner',
    },
  });

  assert.equal(events.some((event) => event.type === 'response.reasoning_summary_text.delta' && event.delta === 'Need context. '), true);
  const completed = events.at(-1)?.response;
  assert.equal(completed.output[0].type, 'reasoning');
  assert.equal(completed.output[0].reasoning_content, 'Need context. ');
  assert.equal(completed.output[1].content[0].text, 'Done');
  assert.equal(completed.usage.output_tokens_details.reasoning_tokens, 3);
});

test('codex++ port: streaming response splits inline think across chunks', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      id: 'chatcmpl_inline_think',
      model: 'MiniMax-M2.7',
      choices: [{
        delta: {
          content: '<think>\nNeed',
        },
      }],
    }),
    JSON.stringify({
      id: 'chatcmpl_inline_think',
      model: 'MiniMax-M2.7',
      choices: [{
        delta: {
          content: ' context.</think>\n\npong',
        },
        finish_reason: 'stop',
      }],
    }),
  ], {
    request: {
      model: 'MiniMax-M2.7',
    },
  });

  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('<think>'), false);
  assert.equal(serialized.includes('</think>'), false);
  const completed = events.at(-1)?.response;
  assert.equal(completed.output[0].type, 'reasoning');
  assert.equal(completed.output[0].summary[0].text, 'Need context.');
  assert.equal(completed.output[1].content[0].text, 'pong');
});
