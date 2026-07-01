import crypto from 'node:crypto';
import {
  applyThinkingPolicyToOpenAIChatRequest,
  resolveOpenAICompatibleProviderCapabilitiesForModel,
  type OpenAICompatibleProviderCapabilities,
  type OpenAICompatiblePayloadRule,
} from '../capabilities/thinking_policy.js';
import {
  type CodexToolContext,
  buildCodexToolContext,
  customToolSpec,
  flattenNamespaceToolName,
  isCustomToolProxy,
  openaiNameForFunctionTool,
  originalCustomToolName,
  responsesToolsToChatTools,
} from './codex_tool_context.js';
import {
  APPLY_PATCH_TOOL_NAME,
  applyPatchProxyToolName,
  buildCustomToolCallHistory,
  reconstructApplyPatchInput,
  reconstructCustomToolCallInput,
} from './apply_patch_proxy.js';

type JsonRecord = Record<string, any>;
type ToolNameMap = Map<string, string>;

const THINK_OPEN_TAG = '<think>';
const THINK_CLOSE_TAG = '</think>';

export interface ResponsesToChatOptions {
  model?: string | null;
  stream?: boolean | null;
  providerKind?: string | null;
  providerCapabilities?: OpenAICompatibleProviderCapabilities | null;
  compact?: boolean | null;
}

export interface ChatToResponsesOptions {
  request?: JsonRecord | null;
  responseId?: string | null;
  createdAt?: number | null;
  providerCapabilities?: OpenAICompatibleProviderCapabilities | null;
  modelMetadata?: JsonRecord | null;
}

export interface ResponsesSseTranslateOptions extends ChatToResponsesOptions {
  traceEvent?: ((event: JsonRecord) => void) | null;
}

interface StreamToolCallState {
  key: string;
  id: string | null;
  callId: string | null;
  name: string;
  arguments: string;
  outputIndex: number | null;
  added: boolean;
  done: boolean;
}

type InlineThinkMode = 'detecting' | 'reasoning' | 'text';

interface InlineThinkState {
  mode: InlineThinkMode;
  buffer: string;
}

interface StreamState {
  responseId: string;
  createdAt: number;
  responseModel: string | null;
  sequence: number;
  request: JsonRecord;
  output: JsonRecord[];
  nextOutputIndex: number;
  messageStates: Map<number, {
    id: string;
    outputIndex: number;
    text: string;
    added: boolean;
    contentAdded: boolean;
    done: boolean;
  }>;
  inlineThinkStates: Map<number, InlineThinkState>;
  reasoningStates: Map<number, {
    id: string;
    outputIndex: number;
    text: string;
    added: boolean;
    partAdded: boolean;
    done: boolean;
  }>;
  toolCalls: Map<string, StreamToolCallState>;
  createdEmitted: boolean;
  terminalEmitted: boolean;
  failedError: JsonRecord | null;
  usage: JsonRecord | null;
  providerCapabilities: OpenAICompatibleProviderCapabilities | null;
  reverseToolNameMap: ToolNameMap;
  toolContext: CodexToolContext;
}

interface InputConversionState {
  pendingToolCalls: JsonRecord[];
  pendingReasoning: string[];
  seenToolCallIds: Set<string>;
}

export function responsesRequestToChatCompletions(
  request: JsonRecord,
  options: ResponsesToChatOptions = {},
): JsonRecord {
  const toolContext = buildCodexToolContext(request?.tools);
  const toolNameMap = buildToolNameMap(request);
  const model = normalizeString(options.model) || normalizeString(request?.model);
  const providerCapabilities = resolveOpenAICompatibleProviderCapabilitiesForModel(
    options.providerCapabilities,
    model,
  );
  const chat: JsonRecord = {
    model,
    messages: [],
    stream: Boolean(options.stream ?? request?.stream),
  };
  const builtinWebSearchTransport = resolveBuiltinWebSearchTransport(providerCapabilities);

  copyIfPresent(request, chat, 'temperature');
  copyIfPresent(request, chat, 'top_p');
  copyIfPresent(request, chat, 'top_logprobs');
  copyIfPresent(request, chat, 'user');
  if (request?.max_output_tokens !== undefined) {
    if (isOpenAIOFamilyModel(model)) {
      chat.max_completion_tokens = request.max_output_tokens;
    } else {
      chat.max_tokens = request.max_output_tokens;
    }
  }
  copyIfPresent(request, chat, 'max_tokens');
  copyIfPresent(request, chat, 'max_completion_tokens');
  if (chat.stream) {
    chat.stream_options = {
      ...(chat.stream_options && typeof chat.stream_options === 'object' ? chat.stream_options : {}),
      include_usage: true,
    };
  }
  if (
    builtinWebSearchTransport === 'chat_enable_search'
    && requestUsesBuiltinWebSearch(request)
  ) {
    chat.enable_search = true;
  }
  const toolsSupported = supportsToolCalling(providerCapabilities);
  const responseFormat = convertResponsesTextFormatToChatResponseFormat(request?.text);
  if (responseFormat) {
    chat.response_format = responseFormat;
  }

  const instructions = instructionText(request?.instructions);
  if (instructions) {
    chat.messages.push({
      role: 'system',
      content: instructions,
    });
  }

  const inputItems = typeof request?.input === 'string'
    ? [{
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: request.input,
      }],
    }]
    : normalizeArray(request?.input);
  const inputState = createInputConversionState();
  for (const item of inputItems) {
    appendInputItem(chat.messages, item, toolNameMap, providerCapabilities, inputState);
  }
  flushPendingToolCalls(chat.messages, inputState);
  flushPendingReasoning(chat.messages, inputState);
  normalizeChatMessages(chat.messages);
  chat.messages = collapseSystemMessagesToHead(chat.messages);

  const tools = toolsSupported
    ? responsesToolsToChatTools(request?.tools, toolContext, {
      shortenToolName: (name) => shortenToolName(name, toolNameMap),
      builtinToolConverter: (tool) => convertResponsesBuiltinToolToChatTool(
        tool,
        options.providerKind,
        providerCapabilities,
        builtinWebSearchTransport,
      ),
    })
    : [];
  if (tools.length > 0) {
    chat.tools = tools;
    if (request?.tool_choice !== undefined) {
      const toolChoice = convertResponsesToolChoiceToChatToolChoice(
        request.tool_choice,
        options.providerKind,
        providerCapabilities,
        toolNameMap,
        builtinWebSearchTransport,
      );
      if (toolChoice !== undefined) {
        chat.tool_choice = toolChoice;
      }
    }
    copyIfPresent(request, chat, 'parallel_tool_calls');
  } else if (normalizeArray(request?.tools).length > 0) {
    delete chat.tool_choice;
    delete chat.parallel_tool_calls;
  }

  applyThinkingPolicyToOpenAIChatRequest(chat, {
    providerKind: options.providerKind,
    requestedEffort: request?.reasoning?.effort ?? null,
    capabilities: providerCapabilities,
  });

  applyOpenAICompatiblePayloadCompatibility(chat, {
    model,
    protocol: options.providerKind,
    providerCapabilities,
  });

  return omitUndefined(chat);
}

export function chatCompletionsResponseToResponses(
  chatResponse: JsonRecord,
  options: ChatToResponsesOptions = {},
): JsonRecord {
  const request = options.request ?? {};
  const reverseToolNameMap = buildReverseToolNameMap(request);
  const toolContext = buildCodexToolContext(request?.tools);
  const responseId = normalizeString(options.responseId)
    || normalizeString(chatResponse?.id)
    || `resp_${crypto.randomUUID()}`;
  const createdAt = normalizeNumber(options.createdAt)
    ?? normalizeNumber(chatResponse?.created)
    ?? Math.floor(Date.now() / 1000);
  const output: JsonRecord[] = [];

  for (const choice of normalizeArray(chatResponse?.choices)) {
    const message = choice?.message ?? {};
    const rawText = typeof message?.content === 'string' ? message.content : normalizeString(message?.content);
    const inlineThink = splitLeadingThinkBlock(rawText);
    const text = inlineThink ? normalizeString(inlineThink.answer) : normalizeString(rawText);
    const explicitReasoningContent = extractReasoningText(message);
    const reasoningContent = explicitReasoningContent || inlineThink?.reasoning || '';
    const toolCalls = normalizeArray(message?.tool_calls);
    if (reasoningContent || request?.reasoning) {
      output.push(buildCompletedReasoningOutputItem(reasoningContent));
    }
    if (text) {
      output.push({
        id: `msg_${crypto.randomUUID()}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: text
          ? [{
            type: 'output_text',
            text,
            annotations: [],
          }]
          : [],
      });
    }
    for (const toolCall of toolCalls) {
      output.push(chatToolCallToResponseOutputItem(toolCall, reverseToolNameMap, toolContext));
    }
  }

  return buildResponsesObject({
    responseId,
    createdAt,
    request,
    responseModel: normalizeString(chatResponse?.model) || null,
    status: 'completed',
    output,
    usage: withUsagePricingMetadata(
      mapProviderUsage(chatResponse)
        ?? estimateUsageIfEnabled(request, output, options),
      options.modelMetadata,
    ),
  });
}

export function responsesRequestToCompactionResponse(
  request: JsonRecord,
  options: ChatToResponsesOptions = {},
): JsonRecord {
  const responseId = normalizeString(options.responseId) || `resp_${crypto.randomUUID()}`;
  const createdAt = normalizeNumber(options.createdAt) ?? Math.floor(Date.now() / 1000);
  const output = normalizeCompactionOutput(request?.input);
  return omitUndefined({
    id: responseId,
    object: 'response.compaction',
    created_at: createdAt,
    output,
    usage: withUsagePricingMetadata(
      estimateUsageIfEnabled(request, output, options),
      options.modelMetadata,
    ),
  });
}

export function inspectOpenAICompatiblePayloadCompatibility(
  {
    model,
    protocol,
    providerCapabilities,
  }: {
    model: string;
    protocol?: string | null;
    providerCapabilities: OpenAICompatibleProviderCapabilities | null | undefined;
  },
): {
  upstreamModel: string;
  filteredPaths: string[];
  maxOutputTokens: number | null;
} {
  const normalizedModel = normalizeString(model);
  const probe: JsonRecord = { model: normalizedModel };
  const filteredPaths = applyOpenAICompatiblePayloadRules(probe, {
    model: normalizedModel,
    protocol,
    providerCapabilities,
  });
  return {
    upstreamModel: normalizeString(probe.model) || normalizedModel,
    filteredPaths,
    maxOutputTokens: resolveModelMaxOutputTokens(providerCapabilities, normalizedModel),
  };
}

export function translateChatCompletionsSseToResponsesEvents(
  chunks: Iterable<string>,
  options: ResponsesSseTranslateOptions = {},
): JsonRecord[] {
  const state = createStreamState(options);
  const traceEvent = typeof options.traceEvent === 'function' ? options.traceEvent : null;
  const events: JsonRecord[] = [];
  for (const chunk of chunks) {
    for (const event of translateChatCompletionStreamData(chunk, state)) {
      traceEvent?.(event);
      events.push(event);
    }
  }
  for (const event of finishStreamState(state)) {
    traceEvent?.(event);
    events.push(event);
  }
  return events;
}

export async function* translateChatCompletionsSseStreamToResponsesSse(
  chunks: AsyncIterable<string>,
  options: ResponsesSseTranslateOptions = {},
): AsyncGenerator<string> {
  const state = createStreamState(options);
  const traceEvent = typeof options.traceEvent === 'function' ? options.traceEvent : null;
  try {
    for await (const chunk of chunks) {
      for (const event of translateChatCompletionStreamData(chunk, state)) {
        traceEvent?.(event);
        yield formatSseEvent(event);
      }
    }
    for (const event of finishStreamState(state)) {
      traceEvent?.(event);
      yield formatSseEvent(event);
    }
  } catch (error) {
    for (const event of failStreamState(state, normalizeUnknownErrorObject(error))) {
      traceEvent?.(event);
      yield formatSseEvent(event);
    }
  }
  yield 'data: [DONE]\n\n';
}

function appendInputItem(
  messages: JsonRecord[],
  item: JsonRecord,
  toolNameMap: ToolNameMap,
  providerCapabilities: OpenAICompatibleProviderCapabilities | null | undefined = null,
  state: InputConversionState = createInputConversionState(),
) {
  if (!item || typeof item !== 'object') {
    return;
  }
  const type = normalizeString(item.type);
  if (type === 'message') {
    const role = normalizeRole(item.role);
    const content = convertResponsesContentToChatContent(item.content, providerCapabilities);
    const reasoningContent = role === 'assistant'
      ? normalizeString(item.reasoning_content)
      : null;
    if (role !== 'assistant') {
      flushPendingToolCalls(messages, state);
      flushPendingReasoning(messages, state);
    } else if (state.pendingToolCalls.length > 0) {
      flushPendingToolCalls(messages, state);
    }
    if (content !== null || reasoningContent || role === 'assistant') {
      const pendingReasoning = role === 'assistant'
        ? takePendingReasoningText(state)
        : '';
      messages.push(omitUndefined({
        role,
        content: content ?? '',
        reasoning_content: joinTextBlocks([reasoningContent, pendingReasoning]) || undefined,
      }));
    }
    return;
  }
  if (type === 'reasoning') {
    const reasoning = responsesReasoningText(item);
    if (reasoning) {
      state.pendingReasoning.push(reasoning);
    }
    return;
  }
  if (type === 'custom_tool_call') {
    if (!supportsToolCalling(providerCapabilities)) {
      messages.push({
        role: 'assistant',
        content: formatUnsupportedCustomToolCallAsText(item),
      });
      return;
    }
    const callId = responseToolCallId(item);
    if (!callId) {
      return;
    }
    state.seenToolCallIds.add(callId);
    const toolCall = customToolCallToChatToolCall(item, toolNameMap);
    state.pendingToolCalls.push(toolCall);
    return;
  }
  if (type === 'custom_tool_call_output') {
    const callId = normalizeString(item.call_id);
    if (!callId) {
      return;
    }
    if (!supportsToolCalling(providerCapabilities)) {
      messages.push({
        role: 'user',
        content: formatUnsupportedToolOutputAsText(item),
      });
      return;
    }
    if (!state.seenToolCallIds.has(callId)) {
      flushPendingToolCalls(messages, state);
      flushPendingReasoning(messages, state);
      messages.push(orphanToolOutputMessage(callId, item.output));
      return;
    }
    flushPendingToolCalls(messages, state);
    messages.push({
      role: 'tool',
      tool_call_id: callId,
      content: normalizeString(item.output) || '',
    });
    return;
  }
  if (type === 'function_call') {
    if (!supportsToolCalling(providerCapabilities)) {
      messages.push({
        role: 'assistant',
        content: formatUnsupportedToolCallAsText(item),
      });
      return;
    }
    const callId = responseToolCallId(item);
    if (!callId) {
      return;
    }
    state.seenToolCallIds.add(callId);
    const toolCall = {
      id: callId,
      type: 'function',
      function: {
        name: shortenToolName(
          flattenNamespaceToolName(normalizeString(item.namespace), normalizeString(item.name) || 'tool'),
          toolNameMap,
        ),
        arguments: normalizeString(item.arguments) || '',
      },
    };
    state.pendingToolCalls.push(toolCall);
    return;
  }
  if (type === 'function_call_output') {
    const callId = normalizeString(item.call_id);
    if (!callId) {
      return;
    }
    if (!supportsToolCalling(providerCapabilities)) {
      messages.push({
        role: 'user',
        content: formatUnsupportedToolOutputAsText(item),
      });
      return;
    }
    if (!state.seenToolCallIds.has(callId)) {
      flushPendingToolCalls(messages, state);
      flushPendingReasoning(messages, state);
      messages.push(orphanToolOutputMessage(callId, item.output));
      return;
    }
    flushPendingToolCalls(messages, state);
    messages.push({
      role: 'tool',
      tool_call_id: callId,
      content: normalizeString(item.output) || '',
    });
  }
}

function createInputConversionState(): InputConversionState {
  return {
    pendingToolCalls: [],
    pendingReasoning: [],
    seenToolCallIds: new Set(),
  };
}

function flushPendingToolCalls(messages: JsonRecord[], state: InputConversionState): void {
  if (state.pendingToolCalls.length === 0) {
    return;
  }
  const toolCalls = state.pendingToolCalls.splice(0);
  const previous = messages.at(-1);
  if (previous?.role === 'assistant') {
    mergeToolCallsIntoAssistantMessage(previous, toolCalls);
    return;
  }
  const reasoningContent = takePendingReasoningText(state);
  messages.push(omitUndefined({
    role: 'assistant',
    content: '',
    reasoning_content: reasoningContent || undefined,
    tool_calls: toolCalls,
  }));
}

function flushPendingReasoning(messages: JsonRecord[], state: InputConversionState): void {
  const reasoningContent = takePendingReasoningText(state);
  if (!reasoningContent) {
    return;
  }
  const previous = messages.at(-1);
  if (previous?.role === 'assistant') {
    appendReasoningToAssistantMessage(previous, reasoningContent);
    return;
  }
  messages.push({
    role: 'assistant',
    content: '',
    reasoning_content: reasoningContent,
  });
}

function mergeToolCallsIntoAssistantMessage(message: JsonRecord, toolCalls: JsonRecord[]): void {
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.push(...toolCalls);
  } else {
    message.tool_calls = toolCalls;
  }
  if (message.content === undefined || message.content === null) {
    message.content = '';
  }
}

function appendReasoningToAssistantMessage(message: JsonRecord, reasoningContent: string): void {
  if (!reasoningContent) {
    return;
  }
  message.reasoning_content = joinTextBlocks([message.reasoning_content, reasoningContent]);
  if (message.content === undefined || message.content === null) {
    message.content = '';
  }
}

function takePendingReasoningText(state: InputConversionState): string {
  const text = joinTextBlocks(state.pendingReasoning);
  state.pendingReasoning.length = 0;
  return text;
}

function responsesReasoningText(item: JsonRecord): string {
  const direct = firstNonEmptyString([
    item.reasoning_content,
    item.content,
    item.text,
  ]);
  if (direct) {
    return direct;
  }
  return normalizeArray(item.summary)
    .map((entry) => firstNonEmptyString([entry?.text, entry?.summary, entry?.content]))
    .filter(Boolean)
    .join('\n');
}

function orphanToolOutputMessage(callId: string, output: unknown): JsonRecord {
  return {
    role: 'user',
    content: `Function call output (${callId}): ${normalizeString(output) || ''}`,
  };
}

function responseToolCallId(item: JsonRecord): string {
  return normalizeString(item.call_id) || normalizeString(item.id);
}

function joinTextBlocks(values: unknown[]): string {
  return values
    .map((value) => normalizeString(value))
    .filter(Boolean)
    .join('\n');
}

function normalizeChatMessages(messages: JsonRecord[]): void {
  for (const message of messages) {
    if (message?.role !== 'assistant') {
      continue;
    }
    const hasContent = message.content !== undefined
      && message.content !== null
      && !(Array.isArray(message.content) && message.content.length === 0);
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!hasContent && !hasToolCalls) {
      message.content = '';
    }
  }
}

function collapseSystemMessagesToHead(messages: JsonRecord[]): JsonRecord[] {
  const systemChunks: string[] = [];
  const rest: JsonRecord[] = [];
  for (const message of messages) {
    if (message?.role === 'system' && typeof message.content === 'string') {
      const content = message.content.trim();
      if (content) {
        systemChunks.push(content);
      }
      continue;
    }
    rest.push(message);
  }
  if (systemChunks.length === 0) {
    return rest;
  }
  return [{
    role: 'system',
    content: systemChunks.join('\n\n'),
  }, ...rest];
}

function supportsToolCalling(providerCapabilities: OpenAICompatibleProviderCapabilities | null | undefined): boolean {
  return providerCapabilities?.supportsTools !== false;
}

function formatUnsupportedToolCallAsText(item: JsonRecord): string {
  const name = normalizeString(item?.name) || 'tool';
  const args = normalizeString(item?.arguments) || '{}';
  return `[Tool call omitted because this model does not support tools: ${name} ${args}]`;
}

function formatUnsupportedCustomToolCallAsText(item: JsonRecord): string {
  const name = normalizeString(item?.name) || 'custom_tool';
  const input = normalizeString(item?.input) || '';
  return `[Custom tool call omitted because this model does not support tools: ${name} ${input}]`;
}

function formatUnsupportedToolOutputAsText(item: JsonRecord): string {
  const callId = normalizeString(item?.call_id) || 'unknown';
  const output = normalizeString(item?.output) || '';
  return `[Tool output omitted because this model does not support tools: ${callId} ${output}]`;
}

function customToolCallToChatToolCall(item: JsonRecord, toolNameMap: ToolNameMap): JsonRecord {
  const name = normalizeString(item.name) || 'custom_tool';
  const history = buildCustomToolCallHistory(name, item.input ?? '');
  return {
    id: responseToolCallId(item) || `call_${crypto.randomUUID()}`,
    type: 'function',
    function: {
      name: shortenToolName(history.name, toolNameMap),
      arguments: history.arguments,
    },
  };
}

function chatToolCallToResponseOutputItem(
  toolCall: JsonRecord,
  reverseToolNameMap: ToolNameMap,
  toolContext: CodexToolContext,
): JsonRecord {
  const callId = normalizeString(toolCall?.id) || `call_${crypto.randomUUID()}`;
  const upstreamName = restoreToolName(normalizeString(toolCall?.function?.name) || 'tool', reverseToolNameMap);
  const argumentsText = normalizeString(toolCall?.function?.arguments) || '';

  if (isCustomToolProxy(toolContext, upstreamName)) {
    const spec = customToolSpec(toolContext, upstreamName);
    const input = spec?.kind === 'apply_patch'
      ? reconstructApplyPatchInput(spec.proxyAction, argumentsText)
      : reconstructCustomToolCallInput(argumentsText);
    return {
      id: `ctc_${callId}`,
      type: 'custom_tool_call',
      status: 'completed',
      call_id: callId,
      name: originalCustomToolName(toolContext, upstreamName),
      input,
    };
  }

  const restored = openaiNameForFunctionTool(toolContext, upstreamName);
  return omitUndefined({
    id: buildFunctionCallItemId(callId),
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name: restored.name,
    namespace: restored.namespace || undefined,
    arguments: argumentsText,
  });
}

function buildCompletedReasoningOutputItem(text: string): JsonRecord {
  return omitUndefined({
    id: `rs_${crypto.randomUUID()}`,
    type: 'reasoning',
    reasoning_content: text || undefined,
    summary: text
      ? [{
        type: 'summary_text',
        text,
      }]
      : [],
  });
}

function extractReasoningText(message: JsonRecord): string {
  const direct = firstNonEmptyString([
    message?.reasoning_content,
    message?.reasoning,
    message?.reasoning_text,
    message?.thinking,
    message?.thoughts,
  ]);
  if (direct) {
    return direct;
  }
  return reasoningDetailsText(message?.reasoning_details);
}

function reasoningDetailsText(value: unknown): string {
  const parts: string[] = [];
  for (const detail of normalizeArray(value)) {
    if (!detail || typeof detail !== 'object') {
      continue;
    }
    const record = detail as JsonRecord;
    const direct = firstNonEmptyString([record.summary, record.text, record.content]);
    if (direct) {
      parts.push(direct);
    }
    for (const part of normalizeArray(record.parts)) {
      const text = firstNonEmptyString([part?.text, part?.summary, part?.content]);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join('\n\n');
}

function firstNonEmptyString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function splitLeadingThinkBlock(text: string): { reasoning: string; answer: string } | null {
  const leadingWhitespaceLength = text.length - text.trimStart().length;
  const afterWhitespace = text.slice(leadingWhitespaceLength);
  if (!afterWhitespace.startsWith(THINK_OPEN_TAG)) {
    return null;
  }
  const bodyStart = leadingWhitespaceLength + THINK_OPEN_TAG.length;
  const closeRelative = text.slice(bodyStart).indexOf(THINK_CLOSE_TAG);
  if (closeRelative < 0) {
    return null;
  }
  const closeStart = bodyStart + closeRelative;
  const answerStart = closeStart + THINK_CLOSE_TAG.length;
  return {
    reasoning: text.slice(bodyStart, closeStart).trim(),
    answer: text.slice(answerStart).trimStart(),
  };
}

function leadingThinkPrefixDecision(buffer: string): 'need_more' | 'reasoning' | 'text' {
  const afterWhitespace = buffer.trimStart();
  if (!afterWhitespace) {
    return 'need_more';
  }
  if (afterWhitespace.startsWith(THINK_OPEN_TAG)) {
    return 'reasoning';
  }
  if (THINK_OPEN_TAG.startsWith(afterWhitespace)) {
    return 'need_more';
  }
  return 'text';
}

function drainCompleteInlineThink(
  state: StreamState,
  choiceIndex: number,
  inlineState: InlineThinkState,
): JsonRecord[] {
  const split = splitLeadingThinkBlock(inlineState.buffer);
  if (!split) {
    return [];
  }
  inlineState.mode = 'text';
  inlineState.buffer = '';
  const events: JsonRecord[] = [];
  if (split.reasoning) {
    events.push(...appendReasoningDelta(state, choiceIndex, split.reasoning));
    events.push(...finishReasoningState(state, choiceIndex));
  }
  if (split.answer) {
    events.push(...appendOutputTextDelta(state, choiceIndex, split.answer));
  }
  return events;
}

function flushInlineThinkAtBoundary(state: StreamState, choiceIndex: number): JsonRecord[] {
  const inlineState = state.inlineThinkStates.get(choiceIndex);
  if (!inlineState || inlineState.mode === 'text') {
    return [];
  }
  const events = drainCompleteInlineThink(state, choiceIndex, inlineState);
  if (events.length > 0) {
    return events;
  }
  const buffered = inlineState.buffer;
  const previousMode = inlineState.mode;
  inlineState.buffer = '';
  inlineState.mode = 'text';
  if (!buffered) {
    return [];
  }
  if (previousMode === 'reasoning' || buffered.trimStart().startsWith(THINK_OPEN_TAG)) {
    const reasoning = stripLeadingThinkOpenTag(buffered).trim();
    return reasoning
      ? [
        ...appendReasoningDelta(state, choiceIndex, reasoning),
        ...finishReasoningState(state, choiceIndex),
      ]
      : [];
  }
  return appendOutputTextDelta(state, choiceIndex, buffered);
}

function stripLeadingThinkOpenTag(text: string): string {
  const leadingWhitespaceLength = text.length - text.trimStart().length;
  const afterWhitespace = text.slice(leadingWhitespaceLength);
  return afterWhitespace.startsWith(THINK_OPEN_TAG)
    ? afterWhitespace.slice(THINK_OPEN_TAG.length)
    : text;
}

function buildStreamToolCallItemId(
  upstreamName: string,
  callId: string,
  toolContext: CodexToolContext,
): string {
  return isCustomToolProxy(toolContext, upstreamName)
    ? `ctc_${callId}`
    : buildFunctionCallItemId(callId);
}

function buildStreamToolCallOutputItem(
  toolCall: StreamToolCallState,
  toolContext: CodexToolContext,
): JsonRecord {
  if (isCustomToolProxy(toolContext, toolCall.name)) {
    return {
      id: toolCall.id,
      type: 'custom_tool_call',
      status: 'in_progress',
      call_id: toolCall.callId,
      name: originalCustomToolName(toolContext, toolCall.name),
      input: '',
    };
  }
  const restored = openaiNameForFunctionTool(toolContext, toolCall.name);
  return omitUndefined({
    id: toolCall.id,
    type: 'function_call',
    status: 'in_progress',
    call_id: toolCall.callId,
    name: restored.name || toolCall.name || 'tool',
    namespace: restored.namespace || undefined,
    arguments: '',
  });
}

function updateStreamToolCallOutputItem(
  item: JsonRecord,
  toolCall: StreamToolCallState,
  toolContext: CodexToolContext,
): void {
  if (isCustomToolProxy(toolContext, toolCall.name)) {
    item.name = originalCustomToolName(toolContext, toolCall.name);
    return;
  }
  const restored = openaiNameForFunctionTool(toolContext, toolCall.name);
  item.name = restored.name || toolCall.name || 'tool';
  if (restored.namespace) {
    item.namespace = restored.namespace;
  } else {
    delete item.namespace;
  }
}

function reconstructStreamCustomToolCallInput(
  toolCall: StreamToolCallState,
  toolContext: CodexToolContext,
): string {
  const spec = customToolSpec(toolContext, toolCall.name);
  return spec?.kind === 'apply_patch'
    ? reconstructApplyPatchInput(spec.proxyAction, toolCall.arguments)
    : reconstructCustomToolCallInput(toolCall.arguments);
}

function convertResponsesContentToChatContent(
  content: unknown,
  providerCapabilities: OpenAICompatibleProviderCapabilities | null | undefined = null,
): string | JsonRecord[] | null {
  if (typeof content === 'string') {
    return content;
  }
  const parts = normalizeArray(content)
    .map((part) => {
      const type = normalizeString(part?.type);
      if (type === 'input_text' || type === 'output_text' || type === 'text') {
        return {
          type: 'text',
          text: normalizeString(part?.text) || '',
        };
      }
      if (type === 'input_image' || type === 'image_url') {
        if (providerCapabilities?.multimodal?.supportsImageInput === false) {
          return unsupportedInputPartToText(part, 'image', providerCapabilities);
        }
        const imageUrl = normalizeString(part?.image_url)
          || normalizeString(part?.image_url?.url);
        if (!imageUrl) {
          return null;
        }
        if (imageUrl.startsWith('data:')
          && providerCapabilities?.multimodal?.supportsImageBase64Input === false) {
          return unsupportedInputPartToText(part, 'image', providerCapabilities);
        }
        if (!imageUrl.startsWith('data:')
          && providerCapabilities?.multimodal?.supportsImageUrlInput === false) {
          return unsupportedInputPartToText(part, 'image', providerCapabilities);
        }
        return {
          type: 'image_url',
          image_url: { url: imageUrl },
        };
      }
      if (type === 'input_file' || type === 'file') {
        if (providerCapabilities?.multimodal?.supportsFileInput === false) {
          return unsupportedInputPartToText(part, 'file', providerCapabilities);
        }
        const fileData = normalizeString(part?.file_data)
          || normalizeString(part?.file?.file_data);
        const fileId = normalizeString(part?.file_id)
          || normalizeString(part?.file?.file_id);
        const fileUrl = normalizeString(part?.file_url)
          || normalizeString(part?.file?.file_url);
        const filename = normalizeString(part?.filename)
          || normalizeString(part?.file?.filename);
        if (!fileData && !fileId && !fileUrl) {
          return null;
        }
        if (fileData && providerCapabilities?.multimodal?.supportsFileDataInput === false) {
          return unsupportedInputPartToText(part, 'file', providerCapabilities);
        }
        if (fileId && providerCapabilities?.multimodal?.supportsFileIdInput === false) {
          return unsupportedInputPartToText(part, 'file', providerCapabilities);
        }
        if (fileUrl && providerCapabilities?.multimodal?.supportsFileUrlInput === false) {
          return unsupportedInputPartToText(part, 'file', providerCapabilities);
        }
        return omitUndefined({
          type: 'file',
          file: omitUndefined({
            file_data: fileData || undefined,
            file_id: fileId || undefined,
            file_url: fileUrl || undefined,
            filename: filename || undefined,
          }),
        });
      }
      return null;
    })
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  if (parts.every((part: any) => part.type === 'text')) {
    return parts.map((part: any) => part.text).join('');
  }
  return parts;
}

function instructionText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') {
          return part.trim();
        }
        if (part && typeof part === 'object') {
          return normalizeString((part as JsonRecord).text);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return normalizeString(value);
}

function convertResponsesToolToChatTool(
  tool: JsonRecord,
  providerKind?: string | null,
  providerCapabilities: OpenAICompatibleProviderCapabilities | null = null,
  toolNameMap: ToolNameMap = new Map(),
  builtinWebSearchTransport: 'openai_tool' | 'chat_enable_search' = 'openai_tool',
): JsonRecord | null {
  if (!tool || typeof tool !== 'object') {
    return null;
  }
  const type = normalizeString(tool.type);
  const normalizedBuiltinType = normalizeBuiltinToolType(
    type,
    providerKind,
    providerCapabilities,
    builtinWebSearchTransport,
  );
  if (normalizedBuiltinType) {
    return omitUndefined({
      ...tool,
      type: normalizedBuiltinType,
    });
  }
  if (type !== 'function') {
    return null;
  }
  return {
    type: 'function',
    function: omitUndefined({
      name: shortenToolName(normalizeString(tool.name), toolNameMap),
      description: normalizeString(tool.description),
      parameters: tool.parameters ?? {},
      strict: tool.strict,
    }),
  };
}

function convertResponsesToolChoiceToChatToolChoice(
  toolChoice: unknown,
  providerKind?: string | null,
  providerCapabilities: OpenAICompatibleProviderCapabilities | null = null,
  toolNameMap: ToolNameMap = new Map(),
  builtinWebSearchTransport: 'openai_tool' | 'chat_enable_search' = 'openai_tool',
): unknown {
  if (typeof toolChoice === 'string') {
    const normalizedBuiltinType = normalizeBuiltinToolType(
      toolChoice,
      providerKind,
      providerCapabilities,
      builtinWebSearchTransport,
    );
    if (normalizedBuiltinType) {
      return normalizedBuiltinType;
    }
    if (isBuiltinToolType(toolChoice)) {
      return undefined;
    }
    return toolChoice;
  }
  if (!toolChoice || typeof toolChoice !== 'object') {
    return toolChoice;
  }

  const record = { ...(toolChoice as JsonRecord) };
  const rawType = normalizeString(record.type);
  const normalizedType = normalizeBuiltinToolType(
    rawType,
    providerKind,
    providerCapabilities,
    builtinWebSearchTransport,
  );
  if (normalizedType) {
    record.type = normalizedType;
    return omitUndefined(record);
  }
  if (isBuiltinToolType(rawType)) {
    return undefined;
  }
  if (rawType === 'function') {
    const functionName = shortenToolName(
      flattenNamespaceToolName(
        normalizeString(record.namespace) || normalizeString(record.function?.namespace),
        normalizeString(record.name) || normalizeString(record.function?.name),
      ),
      toolNameMap,
    );
    if (!functionName) {
      return undefined;
    }
    return {
      type: 'function',
      function: {
        name: functionName,
      },
    };
  }

  if (rawType === 'custom') {
    const customName = normalizeString(record.name) || normalizeString(record.custom?.name);
    const functionName = shortenToolName(
      customName === APPLY_PATCH_TOOL_NAME
        ? applyPatchProxyToolName('batch')
        : customName,
      toolNameMap,
    );
    if (!functionName) {
      return undefined;
    }
    return {
      type: 'function',
      function: {
        name: functionName,
      },
    };
  }

  if (rawType === 'allowed_tools') {
    record.tools = normalizeArray(record.tools)
      .map((tool) => convertResponsesToolToChatTool(
        tool,
        providerKind,
        providerCapabilities,
        toolNameMap,
        builtinWebSearchTransport,
      ))
      .filter(Boolean);
    if (record.tools.length === 0) {
      return undefined;
    }
  }
  return omitUndefined(record);
}

function convertResponsesTextFormatToChatResponseFormat(textConfig: unknown): JsonRecord | null {
  if (!textConfig || typeof textConfig !== 'object') {
    return null;
  }
  const format = (textConfig as JsonRecord).format;
  if (!format || typeof format !== 'object') {
    return null;
  }
  const type = normalizeString((format as JsonRecord).type);
  if (type === 'text') {
    return { type: 'text' };
  }
  if (type === 'json_schema') {
    const schema = (format as JsonRecord).schema;
    return omitUndefined({
      type: 'json_schema',
      json_schema: omitUndefined({
        name: normalizeString((format as JsonRecord).name) || 'response',
        strict: (format as JsonRecord).strict,
        schema: schema ?? {},
      }),
    });
  }
  return null;
}

function normalizeBuiltinToolType(
  type: unknown,
  providerKind?: string | null,
  providerCapabilities: OpenAICompatibleProviderCapabilities | null = null,
  builtinWebSearchTransport: 'openai_tool' | 'chat_enable_search' = 'openai_tool',
): string {
  if (builtinWebSearchTransport === 'chat_enable_search') {
    return '';
  }
  if (!supportsBuiltinWebSearchTool(providerKind, providerCapabilities)) {
    return '';
  }
  switch (normalizeString(type)) {
    case 'web_search':
    case 'web_search_preview':
    case 'web_search_preview_2025_03_11':
      return 'web_search';
    default:
      return '';
  }
}

function convertResponsesBuiltinToolToChatTool(
  tool: JsonRecord,
  providerKind?: string | null,
  providerCapabilities: OpenAICompatibleProviderCapabilities | null = null,
  builtinWebSearchTransport: 'openai_tool' | 'chat_enable_search' = 'openai_tool',
): JsonRecord | null {
  if (!tool || typeof tool !== 'object') {
    return null;
  }
  const normalizedBuiltinType = normalizeBuiltinToolType(
    tool.type,
    providerKind,
    providerCapabilities,
    builtinWebSearchTransport,
  );
  return normalizedBuiltinType
    ? omitUndefined({
      ...tool,
      type: normalizedBuiltinType,
    })
    : null;
}

function isBuiltinToolType(type: unknown): boolean {
  switch (normalizeString(type)) {
    case 'web_search':
    case 'web_search_preview':
    case 'web_search_preview_2025_03_11':
      return true;
    default:
      return false;
  }
}

function supportsBuiltinWebSearchTool(
  providerKind?: string | null,
  providerCapabilities: OpenAICompatibleProviderCapabilities | null = null,
): boolean {
  void providerKind;
  if (providerCapabilities?.supportsBuiltinWebSearchTool !== undefined) {
    return Boolean(providerCapabilities.supportsBuiltinWebSearchTool);
  }
  return true;
}

function resolveBuiltinWebSearchTransport(
  providerCapabilities: OpenAICompatibleProviderCapabilities | null,
): 'openai_tool' | 'chat_enable_search' {
  return providerCapabilities?.builtinWebSearchTransport === 'chat_enable_search'
    ? 'chat_enable_search'
    : 'openai_tool';
}

function requestUsesBuiltinWebSearch(request: JsonRecord): boolean {
  if (normalizeArray(request?.tools).some((tool) => isBuiltinToolType(tool?.type))) {
    return true;
  }
  const toolChoice = request?.tool_choice;
  if (typeof toolChoice === 'string') {
    return isBuiltinToolType(toolChoice);
  }
  if (toolChoice && typeof toolChoice === 'object') {
    if (isBuiltinToolType((toolChoice as JsonRecord).type)) {
      return true;
    }
    if (normalizeString((toolChoice as JsonRecord).type) === 'allowed_tools') {
      return normalizeArray((toolChoice as JsonRecord).tools).some((tool) => isBuiltinToolType(tool?.type));
    }
  }
  return false;
}

function translateChatCompletionStreamData(data: string, state: StreamState): JsonRecord[] {
  const trimmed = String(data ?? '').trim();
  if (!trimmed || trimmed === '[DONE]') {
    return [];
  }
  let chunk: JsonRecord;
  try {
    chunk = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (chunk?.error && typeof chunk.error === 'object') {
    return failStreamState(state, normalizeErrorObject(chunk.error));
  }
  if (normalizeString(chunk?.type) === 'error') {
    return failStreamState(state, normalizeTopLevelStreamErrorObject(chunk));
  }
  if (!state.createdEmitted) {
    const upstreamResponseId = normalizeString(chunk?.id);
    const upstreamCreatedAt = normalizeNumber(chunk?.created);
    if (upstreamResponseId) {
      state.responseId = upstreamResponseId;
    }
    if (upstreamCreatedAt !== null) {
      state.createdAt = upstreamCreatedAt;
    }
  }
  const upstreamModel = normalizeString(chunk?.model);
  if (upstreamModel) {
    state.responseModel = upstreamModel;
  }
  const events = ensureStreamStarted(state);
  state.usage = mapProviderUsage(chunk) ?? state.usage;

  for (const choice of normalizeArray(chunk?.choices)) {
    const choiceIndex = Number.isFinite(Number(choice?.index)) ? Number(choice.index) : 0;
    const delta = choice?.delta ?? {};
    const reasoningDelta = typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : '';
    const contentDelta = typeof delta?.content === 'string' ? delta.content : '';
    if (reasoningDelta) {
      events.push(...appendReasoningDelta(state, choiceIndex, reasoningDelta));
    }
    if (contentDelta) {
      events.push(...appendMessageDelta(state, choiceIndex, contentDelta));
    }
    for (const toolCallDelta of normalizeArray(delta?.tool_calls)) {
      events.push(...flushInlineThinkAtBoundary(state, choiceIndex));
      events.push(...appendToolCallDelta(state, choiceIndex, toolCallDelta));
    }
    const finishReason = normalizeString(choice?.finish_reason);
    if (finishReason) {
      events.push(...finishOpenItems(state));
    }
  }

  return events;
}

function createStreamState(options: ResponsesSseTranslateOptions): StreamState {
  return {
    responseId: normalizeString(options.responseId) || `resp_${crypto.randomUUID()}`,
    createdAt: normalizeNumber(options.createdAt) ?? Math.floor(Date.now() / 1000),
    responseModel: normalizeString(options.request?.model) || null,
    sequence: 0,
    request: options.request ?? {},
    output: [],
    nextOutputIndex: 0,
    messageStates: new Map(),
    inlineThinkStates: new Map(),
    reasoningStates: new Map(),
    toolCalls: new Map(),
    createdEmitted: false,
    terminalEmitted: false,
    failedError: null,
    usage: null,
    providerCapabilities: resolveOpenAICompatibleProviderCapabilitiesForModel(
      options.providerCapabilities,
      normalizeString(options.request?.model) || null,
    ),
    reverseToolNameMap: buildReverseToolNameMap(options.request ?? {}),
    toolContext: buildCodexToolContext(options.request?.tools),
  };
}

function ensureStreamStarted(state: StreamState): JsonRecord[] {
  if (state.createdEmitted) {
    return [];
  }
  state.createdEmitted = true;
  const response = buildResponsesObject({
    responseId: state.responseId,
    createdAt: state.createdAt,
    request: state.request,
    responseModel: state.responseModel,
    status: 'in_progress',
    output: [],
    usage: null,
  });
  return [
    withSequence(state, {
      type: 'response.created',
      response,
    }),
    withSequence(state, {
      type: 'response.in_progress',
      response,
    }),
  ];
}

function appendMessageDelta(state: StreamState, choiceIndex: number, delta: string): JsonRecord[] {
  const inlineState = state.inlineThinkStates.get(choiceIndex);
  if (inlineState?.mode === 'text') {
    return appendOutputTextDelta(state, choiceIndex, delta);
  }

  const detector = inlineState ?? { mode: 'detecting' as InlineThinkMode, buffer: '' };
  state.inlineThinkStates.set(choiceIndex, detector);

  if (detector.mode === 'detecting') {
    detector.buffer += delta;
    const decision = leadingThinkPrefixDecision(detector.buffer);
    if (decision === 'need_more') {
      return [];
    }
    if (decision === 'reasoning') {
      detector.mode = 'reasoning';
      return drainCompleteInlineThink(state, choiceIndex, detector);
    }
    detector.mode = 'text';
    const text = detector.buffer;
    detector.buffer = '';
    return appendOutputTextDelta(state, choiceIndex, text);
  }

  detector.buffer += delta;
  return drainCompleteInlineThink(state, choiceIndex, detector);
}

function appendOutputTextDelta(state: StreamState, choiceIndex: number, delta: string): JsonRecord[] {
  const events: JsonRecord[] = [];
  const reasoningState = state.reasoningStates.get(choiceIndex);
  if (reasoningState && !reasoningState.done) {
    events.push(...finishReasoningState(state, choiceIndex));
  }
  const messageState = ensureMessageState(state, choiceIndex, events);
  messageState.text += delta;
  events.push(withSequence(state, {
    type: 'response.output_text.delta',
    item_id: messageState.id,
    output_index: messageState.outputIndex,
    content_index: 0,
    delta,
  }));
  return events;
}

function ensureMessageState(state: StreamState, choiceIndex: number, events: JsonRecord[]) {
  let messageState = state.messageStates.get(choiceIndex);
  if (!messageState) {
    messageState = {
      id: `msg_${crypto.randomUUID()}`,
      outputIndex: allocateOutputIndex(state),
      text: '',
      added: false,
      contentAdded: false,
      done: false,
    };
    state.messageStates.set(choiceIndex, messageState);
    state.output.push({
      id: messageState.id,
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [],
    });
  }
  if (!messageState.added) {
    messageState.added = true;
    events.push(withSequence(state, {
      type: 'response.output_item.added',
      output_index: messageState.outputIndex,
      item: cloneJson(state.output[messageState.outputIndex]),
    }));
  }
  if (!messageState.contentAdded) {
    messageState.contentAdded = true;
    events.push(withSequence(state, {
      type: 'response.content_part.added',
      item_id: messageState.id,
      output_index: messageState.outputIndex,
      content_index: 0,
      part: {
        type: 'output_text',
        text: '',
        annotations: [],
      },
    }));
  }
  return messageState;
}

function appendReasoningDelta(state: StreamState, choiceIndex: number, delta: string): JsonRecord[] {
  const events: JsonRecord[] = [];
  let reasoningState = state.reasoningStates.get(choiceIndex);
  if (!reasoningState || reasoningState.done) {
    reasoningState = {
      id: `rs_${crypto.randomUUID()}`,
      outputIndex: allocateOutputIndex(state),
      text: '',
      added: false,
      partAdded: false,
      done: false,
    };
    state.reasoningStates.set(choiceIndex, reasoningState);
    state.output.push({
      id: reasoningState.id,
      type: 'reasoning',
      status: 'in_progress',
      reasoning_content: '',
      summary: [],
    });
  }
  if (!reasoningState.added) {
    reasoningState.added = true;
    events.push(withSequence(state, {
      type: 'response.output_item.added',
      output_index: reasoningState.outputIndex,
      item: cloneJson(state.output[reasoningState.outputIndex]),
    }));
  }
  if (!reasoningState.partAdded) {
    reasoningState.partAdded = true;
    events.push(withSequence(state, {
      type: 'response.reasoning_summary_part.added',
      item_id: reasoningState.id,
      output_index: reasoningState.outputIndex,
      summary_index: 0,
      part: {
        type: 'summary_text',
        text: '',
      },
    }));
  }
  reasoningState.text += delta;
  events.push(withSequence(state, {
    type: 'response.reasoning_summary_text.delta',
    item_id: reasoningState.id,
    output_index: reasoningState.outputIndex,
    summary_index: 0,
    delta,
  }));
  return events;
}

function appendToolCallDelta(state: StreamState, choiceIndex: number, delta: JsonRecord): JsonRecord[] {
  const events: JsonRecord[] = [];
  const reasoningState = state.reasoningStates.get(choiceIndex);
  if (reasoningState && !reasoningState.done) {
    events.push(...finishReasoningState(state, choiceIndex));
  }
  const messageState = state.messageStates.get(choiceIndex);
  if (messageState && !messageState.done) {
    events.push(...finishMessageState(state, choiceIndex));
  }
  const toolIndex = Number.isFinite(Number(delta?.index)) ? Number(delta.index) : state.toolCalls.size;
  const key = `${choiceIndex}:${toolIndex}`;
  let toolCall = state.toolCalls.get(key) ?? null;
  if (!toolCall) {
    toolCall = {
      key,
      id: null,
      callId: null,
      name: restoreToolName(normalizeString(delta?.function?.name) || 'tool', state.reverseToolNameMap),
      arguments: '',
      outputIndex: null,
      added: false,
      done: false,
    };
    state.toolCalls.set(key, toolCall);
  }
  if (delta?.function?.name) {
    toolCall.name = restoreToolName(normalizeString(delta.function.name) || toolCall.name, state.reverseToolNameMap);
  }
  const argsDelta = typeof delta?.function?.arguments === 'string' ? delta.function.arguments : '';
  if (delta?.id && !toolCall.callId) {
    const callId = normalizeString(delta.id);
    if (callId) {
      toolCall.callId = callId;
      toolCall.id = buildStreamToolCallItemId(toolCall.name, callId, state.toolContext);
      toolCall.outputIndex = allocateOutputIndex(state);
      state.output.push(buildStreamToolCallOutputItem(toolCall, state.toolContext));
    }
  }
  const item = toolCall.outputIndex !== null ? state.output[toolCall.outputIndex] : null;
  if (item) {
    item.call_id = toolCall.callId;
    updateStreamToolCallOutputItem(item, toolCall, state.toolContext);
  }
  if (!toolCall.added && toolCall.outputIndex !== null && item) {
    toolCall.added = true;
    events.push(withSequence(state, {
      type: 'response.output_item.added',
      output_index: toolCall.outputIndex,
      item: cloneJson(item),
    }));
  }
  if (argsDelta) {
    toolCall.arguments += argsDelta;
    if (item && !isCustomToolProxy(state.toolContext, toolCall.name)) {
      item.arguments = toolCall.arguments;
    }
  }
  if (
    argsDelta
    && toolCall.id
    && toolCall.outputIndex !== null
    && !isCustomToolProxy(state.toolContext, toolCall.name)
  ) {
    events.push(withSequence(state, {
      type: 'response.function_call_arguments.delta',
      item_id: toolCall.id,
      output_index: toolCall.outputIndex,
      delta: argsDelta,
    }));
  }
  return events;
}

function finishStreamState(state: StreamState): JsonRecord[] {
  if (state.terminalEmitted) {
    return [];
  }
  if (state.failedError) {
    state.terminalEmitted = true;
    return [
      ...ensureStreamStarted(state),
      ...finishOpenItems(state),
      withSequence(state, {
        type: 'response.failed',
        response: buildResponsesObject({
          responseId: state.responseId,
          createdAt: state.createdAt,
          request: state.request,
          responseModel: state.responseModel,
          status: 'failed',
          output: state.output,
          usage: state.usage,
          error: state.failedError,
        }),
      }),
    ];
  }
  state.terminalEmitted = true;
  return [
    ...ensureStreamStarted(state),
    ...finishOpenItems(state),
    withSequence(state, {
      type: 'response.completed',
      response: buildResponsesObject({
        responseId: state.responseId,
        createdAt: state.createdAt,
        request: state.request,
        responseModel: state.responseModel,
        status: 'completed',
        output: state.output,
        usage: state.usage ?? estimateUsageIfEnabled(state.request, state.output, {
          request: state.request,
          providerCapabilities: state.providerCapabilities,
        }),
      }),
    }),
  ];
}

function finishOpenItems(state: StreamState): JsonRecord[] {
  const events: JsonRecord[] = [];
  const closers: Array<{ outputIndex: number; run: () => JsonRecord[] }> = [];
  for (const choiceIndex of state.inlineThinkStates.keys()) {
    events.push(...flushInlineThinkAtBoundary(state, choiceIndex));
  }
  for (const [choiceIndex, reasoningState] of state.reasoningStates.entries()) {
    if (!reasoningState.done) {
      closers.push({
        outputIndex: reasoningState.outputIndex,
        run: () => finishReasoningState(state, choiceIndex),
      });
    }
  }
  for (const [choiceIndex, messageState] of state.messageStates.entries()) {
    if (!messageState.done) {
      closers.push({
        outputIndex: messageState.outputIndex,
        run: () => finishMessageState(state, choiceIndex),
      });
    }
  }
  for (const toolCall of state.toolCalls.values()) {
    if (!toolCall.done && toolCall.outputIndex === null && (toolCall.name || toolCall.arguments)) {
      repairStreamToolCallIdentity(state, toolCall);
    }
    if (!toolCall.done && toolCall.outputIndex !== null) {
      closers.push({
        outputIndex: toolCall.outputIndex,
        run: () => finishToolCallState(state, toolCall.key),
      });
    }
  }
  closers.sort((left, right) => left.outputIndex - right.outputIndex);
  for (const closer of closers) {
    events.push(...closer.run());
  }
  return events;
}

function failStreamState(state: StreamState, error: JsonRecord): JsonRecord[] {
  if (state.terminalEmitted) {
    return [];
  }
  state.failedError = error;
  return finishStreamState(state);
}

function repairStreamToolCallIdentity(state: StreamState, toolCall: StreamToolCallState): void {
  if (toolCall.outputIndex !== null) {
    return;
  }
  const callId = normalizeString(toolCall.callId) || `call_${crypto.randomUUID()}`;
  toolCall.callId = callId;
  toolCall.id = buildStreamToolCallItemId(toolCall.name, callId, state.toolContext);
  toolCall.outputIndex = allocateOutputIndex(state);
  state.output.push(buildStreamToolCallOutputItem(toolCall, state.toolContext));
}

function finishReasoningState(state: StreamState, choiceIndex: number): JsonRecord[] {
  const reasoningState = state.reasoningStates.get(choiceIndex);
  if (!reasoningState || reasoningState.done) {
    return [];
  }
  reasoningState.done = true;
  const summary = reasoningState.text
    ? [{
      type: 'summary_text',
      text: reasoningState.text,
    }]
    : [];
  const item = state.output[reasoningState.outputIndex];
  item.status = 'completed';
  item.reasoning_content = reasoningState.text;
  item.summary = summary;
  return [
    withSequence(state, {
      type: 'response.reasoning_summary_text.done',
      item_id: reasoningState.id,
      output_index: reasoningState.outputIndex,
      summary_index: 0,
      text: reasoningState.text,
    }),
    withSequence(state, {
      type: 'response.reasoning_summary_part.done',
      item_id: reasoningState.id,
      output_index: reasoningState.outputIndex,
      summary_index: 0,
      part: {
        type: 'summary_text',
        text: reasoningState.text,
      },
    }),
    withSequence(state, {
      type: 'response.output_item.done',
      output_index: reasoningState.outputIndex,
      item: cloneJson(item),
    }),
  ];
}

function finishMessageState(state: StreamState, choiceIndex: number): JsonRecord[] {
  const messageState = state.messageStates.get(choiceIndex);
  if (!messageState || messageState.done) {
    return [];
  }
  messageState.done = true;
  const part = {
    type: 'output_text',
    text: messageState.text,
    annotations: [],
  };
  const item = state.output[messageState.outputIndex];
  item.status = 'completed';
  item.content = [part];
  return [
    withSequence(state, {
      type: 'response.output_text.done',
      item_id: messageState.id,
      output_index: messageState.outputIndex,
      content_index: 0,
      text: messageState.text,
    }),
    withSequence(state, {
      type: 'response.content_part.done',
      item_id: messageState.id,
      output_index: messageState.outputIndex,
      content_index: 0,
      part,
    }),
    withSequence(state, {
      type: 'response.output_item.done',
      output_index: messageState.outputIndex,
      item: cloneJson(item),
    }),
  ];
}

function finishToolCallState(state: StreamState, key: string): JsonRecord[] {
  const toolCall = state.toolCalls.get(key);
  if (!toolCall || toolCall.done || !toolCall.id || toolCall.outputIndex === null) {
    return [];
  }
  toolCall.done = true;
  const item = state.output[toolCall.outputIndex];
  item.status = 'completed';
  if (isCustomToolProxy(state.toolContext, toolCall.name)) {
    const input = reconstructStreamCustomToolCallInput(toolCall, state.toolContext);
    item.input = input;
    return [
      withSequence(state, {
        type: 'response.custom_tool_call_input.delta',
        item_id: toolCall.id,
        call_id: toolCall.callId,
        output_index: toolCall.outputIndex,
        delta: input,
      }),
      withSequence(state, {
        type: 'response.output_item.done',
        output_index: toolCall.outputIndex,
        item: cloneJson(item),
      }),
    ];
  }
  item.arguments = toolCall.arguments || '{}';
  return [
    withSequence(state, {
      type: 'response.function_call_arguments.done',
      item_id: toolCall.id,
      output_index: toolCall.outputIndex,
      arguments: toolCall.arguments || '{}',
    }),
    withSequence(state, {
      type: 'response.output_item.done',
      output_index: toolCall.outputIndex,
      item: cloneJson(item),
    }),
  ];
}

function allocateOutputIndex(state: StreamState): number {
  const index = state.nextOutputIndex;
  state.nextOutputIndex += 1;
  return index;
}

function buildResponsesObject({
  responseId,
  createdAt,
  request,
  responseModel = null,
  status,
  output,
  usage,
  error = null,
}: {
  responseId: string;
  createdAt: number;
  request: JsonRecord;
  responseModel?: string | null;
  status: string;
  output: JsonRecord[];
  usage: JsonRecord | null;
  error?: JsonRecord | null;
}): JsonRecord {
  return omitUndefined({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    error,
    incomplete_details: null,
    background: false,
    instructions: request?.instructions ?? null,
    max_output_tokens: request?.max_output_tokens ?? request?.max_tokens ?? null,
    max_tool_calls: request?.max_tool_calls ?? null,
    model: request?.model ?? responseModel ?? null,
    output,
    parallel_tool_calls: request?.parallel_tool_calls ?? true,
    previous_response_id: request?.previous_response_id ?? null,
    prompt_cache_key: request?.prompt_cache_key ?? null,
    reasoning: request?.reasoning ?? null,
    safety_identifier: request?.safety_identifier ?? null,
    service_tier: request?.service_tier ?? null,
    store: request?.store ?? false,
    temperature: request?.temperature,
    text: request?.text ?? { format: { type: 'text' } },
    tool_choice: request?.tool_choice ?? 'auto',
    tools: request?.tools ?? [],
    top_logprobs: request?.top_logprobs,
    top_p: request?.top_p,
    truncation: request?.truncation ?? 'disabled',
    user: request?.user ?? null,
    metadata: request?.metadata ?? null,
    usage,
  });
}

function normalizeCompactionOutput(input: unknown): JsonRecord[] {
  if (typeof input === 'string') {
    return [{
      id: `msg_${crypto.randomUUID()}`,
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [{
        type: 'input_text',
        text: input,
      }],
    }];
  }
  return normalizeArray(input)
    .map((item) => item && typeof item === 'object' ? cloneJson(item) : null)
    .filter(Boolean);
}

function applyOpenAICompatiblePayloadCompatibility(
  chat: JsonRecord,
  {
    model,
    protocol,
    providerCapabilities,
  }: {
    model: string;
    protocol?: string | null;
    providerCapabilities: OpenAICompatibleProviderCapabilities | null | undefined;
  },
): JsonRecord {
  applyOpenAICompatiblePayloadRules(chat, {
    model,
    protocol,
    providerCapabilities,
  });
  const maxOutputTokens = resolveModelMaxOutputTokens(providerCapabilities, model);
  if (maxOutputTokens !== null && Number(chat.max_tokens) > maxOutputTokens) {
    chat.max_tokens = maxOutputTokens;
  }
  return omitUndefined(chat);
}

function applyOpenAICompatiblePayloadRules(
  target: JsonRecord,
  {
    model,
    protocol,
    providerCapabilities,
  }: {
    model: string;
    protocol?: string | null;
    providerCapabilities: OpenAICompatibleProviderCapabilities | null | undefined;
  },
): string[] {
  const payload = providerCapabilities?.payload;
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  for (const rule of payloadRuleList(payload, 'default')) {
    if (payloadRuleMatchesModel(rule, model, protocol)) {
      applyPayloadParams(target, rule.params, false, rule.root);
    }
  }
  for (const rule of payloadRuleList(payload, 'defaultRaw', 'default-raw')) {
    if (payloadRuleMatchesModel(rule, model, protocol)) {
      applyPayloadParams(target, rule.params, false, rule.root, true);
    }
  }
  for (const rule of payloadRuleList(payload, 'override')) {
    if (payloadRuleMatchesModel(rule, model, protocol)) {
      applyPayloadParams(target, rule.params, true, rule.root);
    }
  }
  for (const rule of payloadRuleList(payload, 'overrideRaw', 'override-raw')) {
    if (payloadRuleMatchesModel(rule, model, protocol)) {
      applyPayloadParams(target, rule.params, true, rule.root, true);
    }
  }

  const filteredPaths: string[] = [];
  for (const rule of payloadRuleList(payload, 'filter')) {
    if (!payloadRuleMatchesModel(rule, model, protocol)) {
      continue;
    }
    for (const path of payloadFilterPaths(rule)) {
      filteredPaths.push(path);
      deleteNestedPath(target, path);
    }
  }

  return [...new Set(filteredPaths)];
}

function payloadRuleList(
  payload: OpenAICompatibleProviderCapabilities['payload'],
  key: keyof NonNullable<OpenAICompatibleProviderCapabilities['payload']>,
  legacyKey?: string,
): OpenAICompatiblePayloadRule[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const primary = payload[key];
  if (Array.isArray(primary)) {
    return primary;
  }
  if (legacyKey) {
    const legacy = (payload as JsonRecord)[legacyKey];
    if (Array.isArray(legacy)) {
      return legacy;
    }
  }
  return [];
}

function applyPayloadParams(
  target: JsonRecord,
  params: Record<string, unknown> | string[] | undefined,
  overwrite: boolean,
  root?: string | null,
  raw = false,
): void {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return;
  }
  for (const [path, value] of Object.entries(params)) {
    if (!path || value === undefined) {
      continue;
    }
    const fullPath = buildPayloadPath(root, path);
    if (!fullPath) {
      continue;
    }
    if (!overwrite && getNestedPath(target, fullPath) !== undefined) {
      continue;
    }
    const nextValue = raw ? normalizeRawPayloadValue(value) : cloneJson(value);
    if (nextValue === undefined) {
      continue;
    }
    setNestedPath(target, fullPath, nextValue);
  }
}

function payloadFilterPaths(rule: OpenAICompatiblePayloadRule): string[] {
  const rawPaths = Array.isArray(rule.paths)
    ? rule.paths
    : Array.isArray(rule.params)
      ? rule.params
      : [];
  return rawPaths
    .map((path) => buildPayloadPath(rule.root, path))
    .filter(Boolean);
}

function payloadRuleMatchesModel(
  rule: OpenAICompatiblePayloadRule,
  model: string,
  protocol?: string | null,
): boolean {
  const patterns = Array.isArray(rule.models)
    ? rule.models.map((entry) => payloadModelRulePattern(entry, protocol)).filter(Boolean)
    : [];
  if (patterns.length === 0) {
    return true;
  }
  const normalizedModel = normalizeString(model).toLowerCase();
  return patterns.some((pattern) => matchesModelPattern(normalizedModel, pattern));
}

function payloadModelRulePattern(entry: unknown, protocol?: string | null): string {
  if (typeof entry === 'string') {
    return normalizeString(entry);
  }
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  const record = entry as JsonRecord;
  const expectedProtocol = normalizeString(record.protocol).toLowerCase();
  const actualProtocol = normalizeString(protocol).toLowerCase();
  if (expectedProtocol && actualProtocol && expectedProtocol !== actualProtocol) {
    return '';
  }
  return normalizeString(record.name);
}

function buildPayloadPath(root: unknown, path: unknown): string {
  const normalizedRoot = normalizeString(root);
  let normalizedPath = normalizeString(path);
  if (!normalizedRoot) {
    return normalizedPath;
  }
  if (!normalizedPath) {
    return normalizedRoot;
  }
  if (normalizedPath.startsWith('.')) {
    normalizedPath = normalizedPath.slice(1);
  }
  return `${normalizedRoot}.${normalizedPath}`;
}

function normalizeRawPayloadValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return cloneJson(value);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function matchesModelPattern(normalizedModel: string, pattern: string): boolean {
  const normalizedPattern = normalizeString(pattern).toLowerCase();
  if (!normalizedPattern || normalizedPattern === '*') {
    return true;
  }
  if (!normalizedPattern.includes('*')) {
    return normalizedModel === normalizedPattern;
  }
  const escaped = normalizedPattern
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'u').test(normalizedModel);
}

function resolveModelMaxOutputTokens(
  providerCapabilities: OpenAICompatibleProviderCapabilities | null | undefined,
  model: string,
): number | null {
  const normalizedModel = normalizeString(model).toLowerCase();
  const catalog = providerCapabilities?.modelCapabilities;
  if (!catalog || typeof catalog !== 'object' || !normalizedModel) {
    return null;
  }
  for (const [key, value] of Object.entries(catalog)) {
    if (normalizeString(key).toLowerCase() !== normalizedModel || !value || typeof value !== 'object') {
      continue;
    }
    const maxOutputTokens = normalizeNumber((value as JsonRecord).maxOutputTokens);
    return maxOutputTokens !== null && maxOutputTokens > 0 ? maxOutputTokens : null;
  }
  return null;
}

function unsupportedInputPartToText(
  part: JsonRecord,
  kind: 'image' | 'file',
  providerCapabilities: OpenAICompatibleProviderCapabilities | null | undefined,
): JsonRecord | null {
  const strategy = providerCapabilities?.multimodal?.unsupportedInputPartStrategy ?? 'text-placeholder';
  if (strategy === 'drop') {
    return null;
  }
  if (strategy === 'error') {
    throw new Error(`OpenAI-compatible provider does not support ${kind} input for this model.`);
  }
  const description = describeUnsupportedInputPart(part, kind);
  return {
    type: 'text',
    text: `[Unsupported ${kind} input omitted: ${description}]`,
  };
}

function describeUnsupportedInputPart(part: JsonRecord, kind: 'image' | 'file'): string {
  if (kind === 'image') {
    const imageUrl = normalizeString(part?.image_url) || normalizeString(part?.image_url?.url);
    if (imageUrl.startsWith('data:')) {
      return 'base64 image';
    }
    return imageUrl || 'image';
  }
  return normalizeString(part?.filename)
    || normalizeString(part?.file?.filename)
    || normalizeString(part?.file_id)
    || normalizeString(part?.file?.file_id)
    || normalizeString(part?.file_url)
    || normalizeString(part?.file?.file_url)
    || 'file';
}

function mapProviderUsage(payload: JsonRecord | null | undefined): JsonRecord | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  return mapClaudeCacheUsage(payload.usage)
    ?? mapGeminiFamilyUsage(payload.usage)
    ?? mapUsage(payload.usage)
    ?? mapGeminiFamilyUsage(
      payload.usageMetadata
        ?? payload.usage_metadata
        ?? payload.response?.usageMetadata
        ?? payload.response?.usage_metadata,
    );
}

function mapUsage(usage: JsonRecord | null | undefined): JsonRecord | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const inputTokens = normalizeNumber(usage.prompt_tokens ?? usage.input_tokens) ?? 0;
  const outputTokens = normalizeNumber(usage.completion_tokens ?? usage.output_tokens) ?? 0;
  const inputTokenDetails = normalizeInputTokenDetails(usage);
  const outputTokenDetails = normalizeOutputTokenDetails(usage);
  return omitUndefined({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: normalizeNumber(usage.total_tokens) ?? inputTokens + outputTokens,
    input_tokens_details: inputTokenDetails ?? undefined,
    output_tokens_details: outputTokenDetails ?? undefined,
  });
}

function withUsagePricingMetadata(
  usage: JsonRecord | null | undefined,
  modelMetadata: JsonRecord | null | undefined,
): JsonRecord | null {
  if (!usage || typeof usage !== 'object') {
    return usage ?? null;
  }
  const pricing = normalizePricingMetadataForUsage(modelMetadata);
  if (!pricing) {
    return usage;
  }
  const metadata = firstRecord(usage.metadata) ?? {};
  const estimatedCost = buildEstimatedCostMetadata(usage, pricing);
  return omitUndefined({
    ...usage,
    metadata: omitUndefined({
      ...metadata,
      pricing,
      estimated_cost: estimatedCost ?? undefined,
    }),
  });
}

function mapGeminiFamilyUsage(usage: unknown): JsonRecord | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const record = usage as JsonRecord;
  const promptTokens = normalizeNumber(record.promptTokenCount ?? record.prompt_token_count) ?? 0;
  const outputTokens = normalizeNumber(record.candidatesTokenCount ?? record.candidates_token_count) ?? 0;
  const reasoningTokens = normalizeNumber(record.thoughtsTokenCount ?? record.thoughts_token_count) ?? 0;
  const cachedTokens = normalizeNumber(record.cachedContentTokenCount ?? record.cached_content_token_count) ?? 0;
  const totalTokens = normalizeNumber(record.totalTokenCount ?? record.total_token_count)
    ?? promptTokens + outputTokens + reasoningTokens;
  if (promptTokens === 0 && outputTokens === 0 && reasoningTokens === 0 && totalTokens === 0) {
    return null;
  }
  return {
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens_details: { reasoning_tokens: reasoningTokens },
  };
}

function mapClaudeCacheUsage(usage: JsonRecord | null | undefined): JsonRecord | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const cacheCreation5m = normalizeNumber(usage.cache_creation_5m_input_tokens);
  const cacheCreation1h = normalizeNumber(usage.cache_creation_1h_input_tokens);
  if (cacheCreation5m === null && cacheCreation1h === null) {
    return null;
  }
  const inputTokens = normalizeNumber(usage.input_tokens ?? usage.prompt_tokens) ?? 0;
  const outputTokens = normalizeNumber(usage.output_tokens ?? usage.completion_tokens) ?? 0;
  const cacheReadTokens = normalizeNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheCreationTokens = (cacheCreation5m ?? 0) + (cacheCreation1h ?? 0);
  const totalTokens = normalizeNumber(usage.total_tokens)
    ?? inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  return omitUndefined({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_5m_input_tokens: cacheCreation5m ?? undefined,
    cache_creation_1h_input_tokens: cacheCreation1h ?? undefined,
    cache_ttl: cacheCreation5m !== null && cacheCreation1h !== null
      ? 'mixed'
      : cacheCreation5m !== null
        ? '5m'
        : '1h',
  });
}

function normalizeInputTokenDetails(usage: JsonRecord): JsonRecord | null {
  const explicit = firstRecord(usage.prompt_tokens_details, usage.input_tokens_details);
  const normalized = omitUndefined({
    ...(explicit ?? {}),
    cached_tokens: normalizeNumber(
      explicit?.cached_tokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_input_tokens,
    ) ?? undefined,
    cache_creation_tokens: normalizeNumber(
      explicit?.cache_creation_tokens
      ?? usage.cache_creation_input_tokens
      ?? usage.cached_creation_input_tokens,
    ) ?? undefined,
    audio_tokens: normalizeNumber(
      explicit?.audio_tokens
      ?? usage.input_audio_tokens
      ?? usage.audio_tokens,
    ) ?? undefined,
  });
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeOutputTokenDetails(usage: JsonRecord): JsonRecord | null {
  const explicit = firstRecord(usage.completion_tokens_details, usage.output_tokens_details);
  const normalized = omitUndefined({
    ...(explicit ?? {}),
    reasoning_tokens: normalizeNumber(
      explicit?.reasoning_tokens
      ?? usage.reasoning_tokens
      ?? usage.thinking_tokens,
    ) ?? undefined,
    audio_tokens: normalizeNumber(
      explicit?.audio_tokens
      ?? usage.output_audio_tokens,
    ) ?? undefined,
    accepted_prediction_tokens: normalizeNumber(
      explicit?.accepted_prediction_tokens
      ?? usage.accepted_prediction_tokens,
    ) ?? undefined,
    rejected_prediction_tokens: normalizeNumber(
      explicit?.rejected_prediction_tokens
      ?? usage.rejected_prediction_tokens,
    ) ?? undefined,
  });
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function firstRecord(...values: unknown[]): JsonRecord | null {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonRecord;
    }
  }
  return null;
}

function normalizePricingMetadataForUsage(modelMetadata: JsonRecord | null | undefined): JsonRecord | null {
  const source = firstRecord(modelMetadata?.pricing, modelMetadata);
  if (!source) {
    return null;
  }
  const pricing = omitUndefined({
    inputCostPerToken: normalizePositiveOrZeroNumber(
      source.inputCostPerToken ?? source.input_cost_per_token,
    ) ?? undefined,
    outputCostPerToken: normalizePositiveOrZeroNumber(
      source.outputCostPerToken ?? source.output_cost_per_token,
    ) ?? undefined,
    inputCostPerAudioToken: normalizePositiveOrZeroNumber(
      source.inputCostPerAudioToken ?? source.input_cost_per_audio_token,
    ) ?? undefined,
    outputCostPerReasoningToken: normalizePositiveOrZeroNumber(
      source.outputCostPerReasoningToken ?? source.output_cost_per_reasoning_token,
    ) ?? undefined,
    inputCostPerImage: normalizePositiveOrZeroNumber(
      source.inputCostPerImage ?? source.input_cost_per_image,
    ) ?? undefined,
    outputCostPerImage: normalizePositiveOrZeroNumber(
      source.outputCostPerImage ?? source.output_cost_per_image,
    ) ?? undefined,
    inputCostPerPixel: normalizePositiveOrZeroNumber(
      source.inputCostPerPixel ?? source.input_cost_per_pixel,
    ) ?? undefined,
    outputCostPerPixel: normalizePositiveOrZeroNumber(
      source.outputCostPerPixel ?? source.output_cost_per_pixel,
    ) ?? undefined,
    searchContextCostPerQuery: normalizePricingObject(
      source.searchContextCostPerQuery ?? source.search_context_cost_per_query,
    ) ?? undefined,
  });
  return Object.keys(pricing).length > 0 ? pricing : null;
}

function buildEstimatedCostMetadata(usage: JsonRecord, pricing: JsonRecord): JsonRecord | null {
  const inputCost = multiplyFinite(
    normalizeNumber(usage.input_tokens),
    normalizeNumber(pricing.inputCostPerToken),
  );
  const outputCost = multiplyFinite(
    normalizeNumber(usage.output_tokens),
    normalizeNumber(pricing.outputCostPerToken),
  );
  const totalCost = [inputCost, outputCost].reduce<number | null>((sum, value) => {
    if (value === null) {
      return sum;
    }
    return (sum ?? 0) + value;
  }, null);
  const estimated = omitUndefined({
    input_cost: inputCost ?? undefined,
    output_cost: outputCost ?? undefined,
    total_cost: totalCost ?? undefined,
  });
  return Object.keys(estimated).length > 0 ? estimated : null;
}

function estimateUsageIfEnabled(
  request: JsonRecord | null | undefined,
  output: JsonRecord[],
  options: ChatToResponsesOptions,
): JsonRecord | null {
  const model = normalizeString(request?.model);
  const providerCapabilities = resolveOpenAICompatibleProviderCapabilitiesForModel(
    options.providerCapabilities,
    model,
  );
  if (!providerCapabilities?.usage?.estimateWhenMissing) {
    return null;
  }
  const inputTokens = estimateTokens([
    request?.instructions,
    request?.input,
    request?.tools,
  ]);
  const outputTokens = estimateTokens(output);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

function estimateTokens(value: unknown): number {
  const text = collectTextForUsage(value).join(' ');
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4));
}

function collectTextForUsage(value: unknown): string[] {
  if (typeof value === 'string') {
    return value ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectTextForUsage(entry));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as JsonRecord;
  const texts: string[] = [];
  for (const key of ['text', 'content', 'arguments', 'output', 'summary', 'instructions', 'name', 'description']) {
    texts.push(...collectTextForUsage(record[key]));
  }
  return texts;
}

function normalizeErrorObject(error: JsonRecord): JsonRecord {
  return omitUndefined({
    message: normalizeString(error?.message)
      || normalizeString(error?.error?.message)
      || JSON.stringify(error),
    type: normalizeString(error?.type) || normalizeString(error?.error?.type) || 'upstream_error',
    code: error?.code ?? error?.error?.code,
    param: error?.param ?? error?.error?.param,
  });
}

function normalizeUnknownErrorObject(error: unknown): JsonRecord {
  if (error && typeof error === 'object') {
    return normalizeErrorObject(error as JsonRecord);
  }
  return {
    message: normalizeString(error) || 'OpenAI-compatible upstream stream failed.',
    type: 'upstream_stream_error',
  };
}

function normalizeTopLevelStreamErrorObject(error: JsonRecord): JsonRecord {
  return omitUndefined({
    message: normalizeString(error?.message) || JSON.stringify(error),
    type: normalizeString(error?.error?.type) || 'upstream_error',
    code: error?.code ?? error?.error?.code,
    param: error?.param ?? error?.error?.param,
  });
}

function formatSseEvent(payload: JsonRecord): string {
  const eventName = normalizeString(payload?.type) || 'message';
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function withSequence(state: StreamState, payload: JsonRecord): JsonRecord {
  const next = {
    ...payload,
    sequence_number: state.sequence,
  };
  state.sequence += 1;
  return next;
}

function normalizeRole(role: unknown): string {
  const normalized = normalizeString(role);
  if (normalized === 'developer') {
    return 'system';
  }
  if (normalized === 'assistant' || normalized === 'system' || normalized === 'tool') {
    return normalized;
  }
  return 'user';
}

function normalizeArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isOpenAIOFamilyModel(model: string): boolean {
  const normalized = normalizeString(model);
  return normalized.length > 1
    && normalized.startsWith('o')
    && Boolean(normalized.at(1)?.match(/[0-9]/u));
}

function normalizeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePositiveOrZeroNumber(value: unknown): number | null {
  const number = normalizeNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function multiplyFinite(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  const product = left * right;
  return Number.isFinite(product) ? product : null;
}

function normalizePricingObject(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const normalized = omitUndefined(Object.fromEntries(
    Object.entries(value as JsonRecord).map(([key, entry]) => [
      key,
      normalizePositiveOrZeroNumber(entry) ?? undefined,
    ]),
  ));
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function copyIfPresent(source: JsonRecord, target: JsonRecord, key: string) {
  if (source?.[key] !== undefined) {
    target[key] = source[key];
  }
}

function getNestedPath(target: JsonRecord, path: string): unknown {
  const segments = normalizePathSegments(path);
  let current: any = target;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setNestedPath(target: JsonRecord, path: string, value: unknown): void {
  const segments = normalizePathSegments(path);
  if (segments.length === 0) {
    return;
  }
  let current: any = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!current[segment] || typeof current[segment] !== 'object' || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments.at(-1) as string] = value;
}

function deleteNestedPath(target: JsonRecord, path: string): void {
  const segments = normalizePathSegments(path);
  if (segments.length === 0) {
    return;
  }
  let current: any = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!current || typeof current !== 'object') {
      return;
    }
    current = current[segment];
  }
  if (current && typeof current === 'object') {
    delete current[segments.at(-1) as string];
  }
}

function normalizePathSegments(path: string): string[] {
  return String(path ?? '')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function buildToolNameMap(request: JsonRecord | null | undefined): ToolNameMap {
  const names = collectChatToolNamesForRequest(request);
  if (names.length === 0) {
    return new Map();
  }
  return buildShortNameMap(names);
}

function collectChatToolNamesForRequest(request: JsonRecord | null | undefined): string[] {
  const names: string[] = [];
  for (const tool of normalizeArray(request?.tools)) {
    if (typeof tool === 'string') {
      names.push(tool);
      continue;
    }
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const record = tool as JsonRecord;
    const type = normalizeString(record.type);
    if (type === 'function') {
      names.push(normalizeString(record.name) || normalizeString(record.function?.name));
      continue;
    }
    if (type === 'custom') {
      const name = normalizeString(record.name);
      if (name === APPLY_PATCH_TOOL_NAME) {
        names.push(
          applyPatchProxyToolName('add_file'),
          applyPatchProxyToolName('delete_file'),
          applyPatchProxyToolName('update_file'),
          applyPatchProxyToolName('replace_file'),
          applyPatchProxyToolName('batch'),
        );
      } else {
        names.push(name);
      }
      continue;
    }
    if (type === 'namespace') {
      const namespace = normalizeString(record.name);
      for (const child of normalizeArray(record.tools)) {
        if (normalizeString(child?.type) === 'function') {
          names.push(flattenNamespaceToolName(namespace, normalizeString(child?.name)));
        }
      }
      continue;
    }
    if (type === 'web_search' || type === 'local_shell' || type === 'computer_use') {
      names.push(normalizeString(record.name) || type);
    }
  }
  return names.filter(Boolean);
}

function buildReverseToolNameMap(request: JsonRecord | null | undefined): ToolNameMap {
  const forward = buildToolNameMap(request);
  const reverse = new Map<string, string>();
  for (const [original, shortened] of forward.entries()) {
    reverse.set(shortened, original);
  }
  return reverse;
}

function shortenToolName(name: string, toolNameMap: ToolNameMap): string {
  const normalized = normalizeString(name);
  if (!normalized) {
    return '';
  }
  return toolNameMap.get(normalized) ?? shortenNameIfNeeded(normalized);
}

function buildFunctionCallItemId(callId: string): string {
  return `fc_${callId}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function restoreToolName(name: string, reverseToolNameMap: ToolNameMap): string {
  const normalized = normalizeString(name);
  if (!normalized) {
    return '';
  }
  return reverseToolNameMap.get(normalized) ?? normalized;
}

function shortenNameIfNeeded(name: string): string {
  const limit = 64;
  if (name.length <= limit) {
    return name;
  }
  if (name.startsWith('mcp__')) {
    const index = name.lastIndexOf('__');
    if (index > 0) {
      const candidate = `mcp__${name.slice(index + 2)}`;
      return candidate.length > limit ? candidate.slice(0, limit) : candidate;
    }
  }
  return name.slice(0, limit);
}

function buildShortNameMap(names: string[]): ToolNameMap {
  const limit = 64;
  const used = new Set<string>();
  const result = new Map<string, string>();

  const baseCandidate = (name: string) => {
    if (name.length <= limit) {
      return name;
    }
    if (name.startsWith('mcp__')) {
      const index = name.lastIndexOf('__');
      if (index > 0) {
        const candidate = `mcp__${name.slice(index + 2)}`;
        return candidate.length > limit ? candidate.slice(0, limit) : candidate;
      }
    }
    return name.slice(0, limit);
  };

  const makeUnique = (candidate: string) => {
    if (!used.has(candidate)) {
      return candidate;
    }
    for (let index = 1; ; index += 1) {
      const suffix = `_${index}`;
      const allowed = Math.max(0, limit - suffix.length);
      const unique = `${candidate.slice(0, allowed)}${suffix}`;
      if (!used.has(unique)) {
        return unique;
      }
    }
  };

  for (const name of names) {
    const normalized = normalizeString(name);
    if (!normalized || result.has(normalized)) {
      continue;
    }
    const shortened = makeUnique(baseCandidate(normalized));
    used.add(shortened);
    result.set(normalized, shortened);
  }

  return result;
}

function omitUndefined<T extends JsonRecord>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record;
}
