import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatCompletionsResponseToResponses,
  responsesRequestToCompactionResponse,
  responsesRequestToChatCompletions,
  translateChatCompletionsSseStreamToResponsesSse,
  translateChatCompletionsSseToResponsesEvents,
} from '../../../src/providers/openai_compatible/responses_adapter.js';
import { getOpenAICompatibleProviderPreset } from '../../../src/providers/openai_compatible/capability_presets.js';

test('responsesRequestToChatCompletions forwards builtin web search tools for providers that support them', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5.4',
    input: 'find latest results',
    tools: [
      { type: 'web_search_preview' },
      { type: 'web_search_preview_2025_03_11' },
    ],
    tool_choice: {
      type: 'allowed_tools',
      tools: [
        { type: 'web_search_preview' },
        { type: 'web_search_preview_2025_03_11' },
      ],
    },
  }, {
    providerKind: 'openai-compatible',
  });

  assert.equal(chat.tools.length, 2);
  assert.equal(chat.tools[0].type, 'web_search');
  assert.equal(chat.tools[1].type, 'web_search');
  assert.equal(chat.tool_choice.type, 'allowed_tools');
  assert.equal(chat.tool_choice.tools.length, 2);
  assert.equal(chat.tool_choice.tools[0].type, 'web_search');
  assert.equal(chat.tool_choice.tools[1].type, 'web_search');
});

test('responsesRequestToChatCompletions strips builtin web search choices when provider capabilities disable them', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'example-model',
    input: 'find latest results',
    tool_choice: 'web_search_preview',
    tools: [
      { type: 'web_search_preview' },
    ],
  }, {
    providerKind: 'example-provider',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: false,
    },
  });

  assert.equal(chat.tool_choice, undefined);
  assert.equal(chat.tools, undefined);
});

test('responsesRequestToChatCompletions shortens long function tool names and restores them in responses', () => {
  const longName = 'mcp__very_long_namespace_segment_that_keeps_going__extremely_long_tool_name_that_exceeds_sixty_four_chars';
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5.4',
    input: [{
      type: 'function_call',
      call_id: 'call_1',
      name: longName,
      arguments: '{"q":"x"}',
    }],
    tools: [{
      type: 'function',
      name: longName,
      description: 'lookup',
      parameters: { type: 'object' },
    }],
    tool_choice: {
      type: 'function',
      name: longName,
    },
  }, {
    providerKind: 'openai-compatible',
  });

  const shortened = chat.tools[0].function.name;
  assert.equal(shortened.length <= 64, true);
  assert.equal(chat.messages[0].tool_calls[0].function.name, shortened);
  assert.equal(chat.tool_choice.function.name, shortened);

  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_1',
    created: 1234,
    choices: [{
      message: {
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: shortened,
            arguments: '{"q":"x"}',
          },
        }],
      },
    }],
  }, {
    request: {
      tools: [{
        type: 'function',
        name: longName,
      }],
    },
  });

  assert.equal(response.output[0].type, 'function_call');
  assert.equal(response.output[0].name, longName);
});

test('responsesRequestToChatCompletions maps input_file and json_schema response format', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'gpt-5.4',
    input: [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_file',
        file_data: 'data:text/plain;base64,SGVsbG8=',
        filename: 'hello.txt',
      }],
    }],
    text: {
      format: {
        type: 'json_schema',
        name: 'result',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
          },
          required: ['answer'],
        },
      },
    },
  }, {
    providerKind: 'openai-compatible',
  });

  assert.equal(chat.messages[0].content[0].type, 'file');
  assert.equal(chat.messages[0].content[0].file.filename, 'hello.txt');
  assert.equal(chat.response_format.type, 'json_schema');
  assert.equal(chat.response_format.json_schema.name, 'result');
  assert.equal(chat.response_format.json_schema.schema.required[0], 'answer');
});

test('responsesRequestToChatCompletions applies capability-driven thinking policy for unknown providers', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'example-model',
    input: 'hello',
    reasoning: { effort: 'high' },
  }, {
    providerKind: 'example-provider',
    providerCapabilities: {
      thinking: {
        supportsReasoningEffortSelection: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        stripFields: ['reasoning_effort'],
        mode: 'disabled',
        disabledThinkingValue: { type: 'disabled' },
      },
    },
  });

  assert.equal(chat.reasoning_effort, undefined);
  assert.deepEqual(chat.thinking, { type: 'disabled' });
});

test('responsesRequestToChatCompletions uses DeepSeek preset without a dedicated provider kind', () => {
  const preset = getOpenAICompatibleProviderPreset('deepseek');
  const chat = responsesRequestToChatCompletions({
    model: 'deepseek-v4-flash',
    input: 'hello',
    reasoning: { effort: 'high' },
    tools: [{ type: 'web_search_preview' }],
    tool_choice: 'web_search_preview',
  }, {
    providerKind: 'openai-compatible',
    providerCapabilities: preset.capabilities,
  });

  assert.equal(chat.reasoning_effort, undefined);
  assert.equal(chat.thinking, undefined);
  assert.equal(chat.tools, undefined);
  assert.equal(chat.tool_choice, undefined);
});

test('responsesRequestToChatCompletions uses MiniMax preset without a dedicated provider kind', () => {
  const preset = getOpenAICompatibleProviderPreset('minimax');
  const chat = responsesRequestToChatCompletions({
    model: 'MiniMax-M2.7',
    input: 'hello',
    reasoning: { effort: 'high' },
    parallel_tool_calls: true,
    tools: [{
      type: 'function',
      name: 'lookup',
      parameters: { type: 'object' },
    }],
  }, {
    providerKind: 'openai-compatible',
    providerCapabilities: preset.capabilities,
  });

  assert.equal(chat.reasoning_effort, 'high');
  assert.equal(chat.thinking, undefined);
  assert.equal(chat.parallel_tool_calls, undefined);
  assert.equal(chat.tools[0].function.name, 'lookup');
});

test('responsesRequestToChatCompletions maps qwen builtin web search to enable_search', () => {
  const preset = getOpenAICompatibleProviderPreset('qwen');
  const chat = responsesRequestToChatCompletions({
    model: 'qwen-plus',
    input: '联网搜索杭州明天天气',
    tools: [{ type: 'web_search' }],
    tool_choice: 'web_search',
  }, {
    providerKind: 'openai-compatible',
    providerCapabilities: preset.capabilities,
  });

  assert.equal(chat.enable_search, true);
  assert.equal(chat.tools, undefined);
  assert.equal(chat.tool_choice, undefined);
});

test('responsesRequestToChatCompletions applies CLIProxy-style iFlow boolean thinking rules', () => {
  const preset = getOpenAICompatibleProviderPreset('iflow');
  const qwen = responsesRequestToChatCompletions({
    model: 'qwen3-max-preview',
    input: 'hello',
    reasoning: { effort: 'high' },
  }, {
    providerKind: 'openai-compatible',
    providerCapabilities: preset.capabilities,
  });
  const qwenOff = responsesRequestToChatCompletions({
    model: 'qwen3-max-preview',
    input: 'hello',
    reasoning: { effort: 'none' },
  }, {
    providerKind: 'openai-compatible',
    providerCapabilities: preset.capabilities,
  });
  const glm = responsesRequestToChatCompletions({
    model: 'glm-4.6',
    input: 'hello',
    reasoning: { effort: 'medium' },
  }, {
    providerKind: 'openai-compatible',
    providerCapabilities: preset.capabilities,
  });
  const minimax = responsesRequestToChatCompletions({
    model: 'minimax-m2-test',
    input: 'hello',
    reasoning: { effort: 'medium' },
  }, {
    providerKind: 'openai-compatible',
    providerCapabilities: {
      ...preset.capabilities,
      modelCapabilities: {
        ...(preset.capabilities?.modelCapabilities ?? {}),
        'minimax-m2-test': {
          reasoning: {
            supportedReasoningEfforts: ['none', 'medium'],
            defaultReasoningEffort: null,
          },
          thinking: {
            supportsReasoningEffortSelection: true,
            supportedReasoningEfforts: ['none', 'medium'],
            defaultReasoningEffort: null,
            stripFields: ['reasoning_effort', 'thinking'],
            mode: 'boolean',
            booleanField: 'reasoning_split',
            booleanFalseEfforts: ['none'],
          },
        },
      },
    },
  });

  assert.equal(qwen.reasoning_effort, undefined);
  assert.equal(qwen.chat_template_kwargs.enable_thinking, true);
  assert.equal(qwenOff.chat_template_kwargs.enable_thinking, false);
  assert.equal(glm.chat_template_kwargs.enable_thinking, true);
  assert.equal(glm.chat_template_kwargs.clear_thinking, false);
  assert.equal(minimax.reasoning_split, true);
});

test('responsesRequestToChatCompletions applies CLIProxy-style Kimi model alias rewrite', () => {
  const preset = getOpenAICompatibleProviderPreset('kimi');
  const chat = responsesRequestToChatCompletions({
    model: 'kimi-k2.5',
    input: 'hello',
    reasoning: { effort: 'high' },
  }, {
    providerKind: 'openai-compatible',
    providerCapabilities: preset.capabilities,
  });

  assert.equal(chat.model, 'k2.5');
  assert.equal(chat.reasoning_effort, 'high');
});

test('responsesRequestToChatCompletions applies provider payload compatibility rules', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'example-pro',
    input: 'hello',
    parallel_tool_calls: true,
    max_output_tokens: 9000,
  }, {
    providerKind: 'example-provider',
    providerCapabilities: {
      payload: {
        default: [{
          params: {
            'extra_body.keep_alive': true,
          },
        }],
        override: [{
          models: ['example-*'],
          params: {
            temperature: 0.2,
          },
        }],
        filter: [{
          paths: ['parallel_tool_calls'],
        }],
      },
      modelCapabilities: {
        'example-pro': {
          maxOutputTokens: 4096,
        },
      },
    },
  });

  assert.equal(chat.extra_body.keep_alive, true);
  assert.equal(chat.temperature, 0.2);
  assert.equal(chat.parallel_tool_calls, undefined);
  assert.equal(chat.max_tokens, 4096);
});

test('responsesRequestToChatCompletions applies CLIProxy-style raw, root, protocol and filter params payload rules', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'example-pro',
    input: 'hello',
    extra_body: {
      existing: true,
    },
  }, {
    providerKind: 'openai-compatible',
    providerCapabilities: {
      payload: {
        'default-raw': [{
          models: [{ name: 'example-*', protocol: 'openai-compatible' }],
          root: 'extra_body',
          params: {
            nested: '{"enabled":true,"count":2}',
          },
        }],
        overrideRaw: [{
          models: [{ name: 'example-pro', protocol: 'openai-compatible' }],
          params: {
            response_format: '{"type":"json_object"}',
          },
        }],
        filter: [{
          models: ['example-*'],
          params: ['extra_body.existing'],
        }],
      } as any,
    },
  });

  assert.deepEqual(chat.extra_body.nested, { enabled: true, count: 2 });
  assert.equal(chat.extra_body.existing, undefined);
  assert.deepEqual(chat.response_format, { type: 'json_object' });
});

test('responsesRequestToChatCompletions applies model capability catalog to tools and multimodal input', () => {
  const chat = responsesRequestToChatCompletions({
    model: 'text-only',
    input: [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_image',
        image_url: 'data:image/png;base64,abc',
      }, {
        type: 'input_file',
        file_data: 'data:application/pdf;base64,abc',
        filename: 'report.pdf',
      }],
    }],
    tools: [{ type: 'web_search_preview' }],
    text: {
      format: {
        type: 'json_schema',
        name: 'result',
        schema: { type: 'object' },
      },
    },
  }, {
    providerKind: 'example-provider',
    providerCapabilities: {
      supportsBuiltinWebSearchTool: true,
      modelCapabilities: {
        'text-only': {
          vision: false,
          fileInput: false,
          jsonSchema: false,
          webSearch: false,
        },
      },
    },
  });

  assert.equal(chat.tools, undefined);
  assert.equal(chat.response_format, undefined);
  assert.equal(chat.messages[0].content.includes('Unsupported image input omitted'), true);
  assert.equal(chat.messages[0].content.includes('Unsupported file input omitted'), true);
});

test('responsesRequestToChatCompletions suppresses tools when model capabilities disable tool calling', () => {
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
      output: 'result',
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
    providerKind: 'example-provider',
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

test('translateChatCompletionsSseToResponsesEvents emits standalone reasoning items before message output', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      id: 'chatcmpl_1',
      created: 1234,
      choices: [{
        index: 0,
        delta: {
          reasoning_content: 'plan',
        },
      }],
    }),
    JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          content: 'answer',
        },
        finish_reason: 'stop',
      }],
    }),
  ], {
    request: {
      model: 'gpt-5.4',
      reasoning: { effort: 'medium' },
    },
  });

  assert.equal(events.some((event) => event.type === 'response.reasoning_summary_text.delta' && event.delta === 'plan'), true);
  const completed = events.at(-1)?.response;
  assert.equal(completed.output[0].type, 'reasoning');
  assert.equal(completed.output[0].summary[0].text, 'plan');
  assert.equal(completed.output[1].type, 'message');
  assert.equal(completed.output[1].content[0].text, 'answer');
});

test('translateChatCompletionsSseToResponsesEvents snapshots output_item.added payloads before later mutations', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      id: 'chatcmpl_1',
      created: 1234,
      choices: [{
        index: 0,
        delta: {
          content: 'hello',
        },
      }],
    }),
    JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          content: ' world',
        },
        finish_reason: 'stop',
      }],
    }),
  ], {
    request: {
      model: 'gpt-5.4',
    },
  });

  const added = events.find((event) => event.type === 'response.output_item.added');
  assert.equal(added?.item?.status, 'in_progress');
  assert.deepEqual(added?.item?.content, []);
  const completed = events.at(-1)?.response;
  assert.equal(completed.output[0].status, 'completed');
  assert.equal(completed.output[0].content[0].text, 'hello world');
});

test('translateChatCompletionsSseToResponsesEvents buffers tool-call deltas until the upstream call id arrives', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              name: 'lookup',
              arguments: '{"q"',
            },
          }],
        },
      }],
    }),
    JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_1',
            function: {
              arguments: ':"x"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
  ], {
    request: {
      model: 'gpt-5.4',
    },
  });

  const added = events.filter((event) => event.type === 'response.output_item.added');
  assert.equal(added.length, 1);
  assert.equal(added[0].item.type, 'function_call');
  assert.equal(added[0].item.call_id, 'call_1');
  assert.equal(added[0].item.arguments, '');
  const deltaEvents = events.filter((event) => event.type === 'response.function_call_arguments.delta');
  assert.equal(deltaEvents.length, 1);
  assert.equal(deltaEvents[0].delta, ':"x"}');
  const completed = events.at(-1)?.response;
  assert.equal(completed.output[0].type, 'function_call');
  assert.equal(completed.output[0].call_id, 'call_1');
  assert.equal(completed.output[0].name, 'lookup');
  assert.equal(completed.output[0].arguments, '{"q":"x"}');
});

test('translateChatCompletionsSseToResponsesEvents repairs tool-call streams that never send an upstream id', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              name: 'lookup',
              arguments: '{"q":"x"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    }),
  ], {
    request: {
      model: 'gpt-5.4',
    },
  });

  const completed = events.at(-1)?.response;
  assert.equal(completed.output[0].type, 'function_call');
  assert.match(completed.output[0].call_id, /^call_/);
  assert.equal(completed.output[0].name, 'lookup');
  assert.equal(completed.output[0].arguments, '{"q":"x"}');
});

test('translateChatCompletionsSseToResponsesEvents maps upstream stream errors to response.failed', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      error: {
        message: 'provider overloaded',
        type: 'rate_limit_error',
        code: 'rate_limit',
      },
    }),
  ], {
    request: {
      model: 'gpt-5.4',
    },
  });

  const failed = events.at(-1);
  assert.equal(failed?.type, 'response.failed');
  assert.equal(failed?.response.status, 'failed');
  assert.equal(failed?.response.error.message, 'provider overloaded');
  assert.equal(failed?.response.error.type, 'rate_limit_error');
});

test('translateChatCompletionsSseToResponsesEvents maps CLIProxy-style top-level stream errors to response.failed', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      type: 'error',
      code: 'rate_limit_exceeded',
      message: 'too many requests',
      sequence_number: 4,
    }),
  ], {
    request: {
      model: 'gpt-5.4',
    },
  });

  const failed = events.at(-1);
  assert.equal(failed?.type, 'response.failed');
  assert.equal(failed?.response.status, 'failed');
  assert.equal(failed?.response.error.message, 'too many requests');
  assert.equal(failed?.response.error.type, 'upstream_error');
  assert.equal(failed?.response.error.code, 'rate_limit_exceeded');
});

test('translateChatCompletionsSseStreamToResponsesSse maps upstream read failures to response.failed', async () => {
  async function* failingStream() {
    yield JSON.stringify({
      id: 'chatcmpl_1',
      created: 1234,
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
      model: 'gpt-5.4',
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

test('chatCompletionsResponseToResponses can estimate usage when provider omits token counts', () => {
  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_1',
    created: 1234,
    choices: [{
      message: {
        content: 'hello world',
      },
    }],
  }, {
    request: {
      model: 'example-model',
      input: 'hello',
    },
    providerCapabilities: {
      usage: {
        estimateWhenMissing: true,
      },
    },
  });

  assert.equal(response.usage.input_tokens > 0, true);
  assert.equal(response.usage.output_tokens > 0, true);
  assert.equal(response.usage.total_tokens, response.usage.input_tokens + response.usage.output_tokens);
});

test('chatCompletionsResponseToResponses maps Gemini-family usageMetadata into Responses usage', () => {
  const response = chatCompletionsResponseToResponses({
    id: 'chatcmpl_1',
    created: 1234,
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 3,
      cachedContentTokenCount: 4,
      totalTokenCount: 33,
    },
    choices: [{
      message: {
        content: 'hello',
      },
    }],
  }, {
    request: {
      model: 'gemini-2.5-pro',
    },
  });

  assert.equal(response.usage.input_tokens, 6);
  assert.equal(response.usage.output_tokens, 20);
  assert.equal(response.usage.total_tokens, 33);
  assert.equal(response.usage.input_tokens_details.cached_tokens, 4);
  assert.equal(response.usage.output_tokens_details.reasoning_tokens, 3);
});

test('chatCompletionsResponseToResponses maps Codex++ Gemini and Claude cache usage semantics', () => {
  const gemini = chatCompletionsResponseToResponses({
    id: 'chatcmpl_gemini_usage',
    created: 123,
    model: 'gemini-proxy',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: {
      promptTokenCount: 20,
      cachedContentTokenCount: 5,
      candidatesTokenCount: 7,
    },
  });
  assert.equal(gemini.usage.input_tokens, 15);
  assert.equal(gemini.usage.output_tokens, 7);
  assert.equal(gemini.usage.total_tokens, 27);
  assert.equal(gemini.usage.input_tokens_details.cached_tokens, 5);

  const claude = chatCompletionsResponseToResponses({
    id: 'chatcmpl_claude_usage',
    created: 123,
    model: 'claude-proxy',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_5m_input_tokens: 4,
      cache_creation_1h_input_tokens: 6,
    },
  });
  assert.equal(claude.usage.input_tokens, 10);
  assert.equal(claude.usage.output_tokens, 3);
  assert.equal(claude.usage.total_tokens, 25);
  assert.equal(claude.usage.cache_read_input_tokens, 2);
  assert.equal(claude.usage.cache_creation_5m_input_tokens, 4);
  assert.equal(claude.usage.cache_creation_1h_input_tokens, 6);
  assert.equal(claude.usage.cache_ttl, 'mixed');
  assert.equal(claude.usage.input_tokens_details, undefined);
});

test('translateChatCompletionsSseToResponsesEvents maps stream usageMetadata into completed usage', () => {
  const events = translateChatCompletionsSseToResponsesEvents([
    JSON.stringify({
      id: 'chatcmpl_1',
      created: 1234,
      choices: [{
        index: 0,
        delta: {
          content: 'OK',
        },
        finish_reason: 'stop',
      }],
      usageMetadata: {
        promptTokenCount: 2,
        candidatesTokenCount: 1,
        thoughtsTokenCount: 5,
        totalTokenCount: 8,
      },
    }),
  ], {
    request: {
      model: 'gemini-2.5-pro',
    },
  });

  const completed = events.at(-1)?.response;
  assert.equal(completed.usage.input_tokens, 2);
  assert.equal(completed.usage.output_tokens, 1);
  assert.equal(completed.usage.output_tokens_details.reasoning_tokens, 5);
  assert.equal(completed.usage.total_tokens, 8);
});

test('responsesRequestToCompactionResponse returns a local no-op compaction fallback', () => {
  const response = responsesRequestToCompactionResponse({
    model: 'example-model',
    input: 'keep this context',
  }, {
    responseId: 'resp_compact_1',
    createdAt: 1234,
    providerCapabilities: {
      usage: {
        estimateWhenMissing: true,
      },
    },
  });

  assert.equal(response.id, 'resp_compact_1');
  assert.equal(response.object, 'response.compaction');
  assert.equal(response.output[0].role, 'user');
  assert.equal(response.output[0].content[0].text, 'keep this context');
  assert.equal(response.usage.input_tokens > 0, true);
});
