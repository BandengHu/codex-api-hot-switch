import crypto from 'node:crypto';

type JsonRecord = Record<string, any>;

export interface ResponsesWebSocketRepairState {
  lastRequest?: JsonRecord | null;
  lastResponseOutput?: JsonRecord[] | null;
  allowIncrementalInputWithPreviousResponseID?: boolean | null;
}

export interface ResponsesWebSocketNormalizeResult {
  request: JsonRecord;
  nextLastRequest: JsonRecord;
  mode: 'initial' | 'merge' | 'transcript-replacement' | 'incremental';
}

export interface ResponsesWebSocketToolRepairCache {
  outputsByCallId: Map<string, JsonRecord>;
  callsByCallId: Map<string, JsonRecord>;
}

export class ResponsesWebSocketRepairError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ResponsesWebSocketRepairError';
    this.statusCode = statusCode;
  }
}

export function createResponsesWebSocketToolRepairCache(): ResponsesWebSocketToolRepairCache {
  return {
    outputsByCallId: new Map(),
    callsByCallId: new Map(),
  };
}

export function normalizeResponsesWebSocketRequest(
  rawRequest: JsonRecord,
  state: ResponsesWebSocketRepairState = {},
): ResponsesWebSocketNormalizeResult {
  const requestType = normalizeString(rawRequest?.type);
  if (requestType === 'response.create') {
    if (!state.lastRequest) {
      const request = normalizeInitialCreateRequest(rawRequest);
      return {
        request,
        nextLastRequest: cloneJson(request),
        mode: 'initial',
      };
    }
    return normalizeSubsequentRequest(rawRequest, state);
  }
  if (requestType === 'response.append') {
    return normalizeSubsequentRequest(rawRequest, state);
  }
  throw new ResponsesWebSocketRepairError(`Unsupported websocket request type: ${requestType || '(missing)'}`);
}

export function shouldReplaceResponsesWebSocketTranscript(rawRequest: JsonRecord): boolean {
  const requestType = normalizeString(rawRequest?.type);
  if (requestType !== 'response.create' && requestType !== 'response.append') {
    return false;
  }
  if (normalizeString(rawRequest?.previous_response_id)) {
    return false;
  }
  const input = normalizeArrayOrNull(rawRequest?.input);
  if (!input) {
    return false;
  }
  return input.some((item) => {
    const type = normalizeString(item?.type);
    if (type === 'function_call' || type === 'custom_tool_call') {
      return true;
    }
    return type === 'message' && normalizeString(item?.role) === 'assistant';
  });
}

export function repairResponsesWebSocketToolCalls(
  request: JsonRecord,
  cache: ResponsesWebSocketToolRepairCache = createResponsesWebSocketToolRepairCache(),
): JsonRecord {
  const input = normalizeArrayOrNull(request?.input);
  if (!input) {
    return request;
  }
  const repairedInput = repairResponsesWebSocketToolCallInput(input, cache, {
    allowOrphanOutputs: Boolean(normalizeString(request?.previous_response_id)),
  });
  if (repairedInput === input) {
    return request;
  }
  return {
    ...request,
    input: repairedInput,
  };
}

export function repairResponsesWebSocketToolCallInput(
  input: JsonRecord[],
  cache: ResponsesWebSocketToolRepairCache = createResponsesWebSocketToolRepairCache(),
  { allowOrphanOutputs = false }: { allowOrphanOutputs?: boolean } = {},
): JsonRecord[] {
  const outputPresent = new Set<string>();
  const callPresent = new Set<string>();

  for (const item of input) {
    const type = normalizeString(item?.type);
    const callId = normalizeString(item?.call_id);
    if (!callId) {
      continue;
    }
    if (isToolOutputType(type)) {
      outputPresent.add(callId);
      cache.outputsByCallId.set(callId, cloneJson(item));
    } else if (isToolCallType(type)) {
      callPresent.add(callId);
      cache.callsByCallId.set(callId, cloneJson(item));
    }
  }

  const filtered: JsonRecord[] = [];
  const insertedCalls = new Set<string>();
  for (const item of input) {
    const type = normalizeString(item?.type);
    if (!isToolCallType(type) && !isToolOutputType(type)) {
      filtered.push(item);
      continue;
    }

    const callId = normalizeString(item?.call_id);
    if (!callId) {
      continue;
    }

    if (isToolOutputType(type)) {
      if (allowOrphanOutputs || callPresent.has(callId)) {
        filtered.push(item);
        continue;
      }
      const cachedCall = cache.callsByCallId.get(callId);
      if (cachedCall) {
        if (!insertedCalls.has(callId)) {
          filtered.push(cloneJson(cachedCall));
          insertedCalls.add(callId);
          callPresent.add(callId);
        }
        filtered.push(item);
      }
      continue;
    }

    if (outputPresent.has(callId)) {
      filtered.push(item);
      continue;
    }
    const cachedOutput = cache.outputsByCallId.get(callId);
    if (cachedOutput) {
      filtered.push(item);
      filtered.push(cloneJson(cachedOutput));
    }
  }
  return filtered;
}

export function recordResponsesWebSocketToolCallsFromEvent(
  cache: ResponsesWebSocketToolRepairCache,
  event: JsonRecord,
): void {
  if (!cache || !event || typeof event !== 'object') {
    return;
  }
  const eventType = normalizeString(event.type);
  if (eventType === 'response.completed') {
    recordToolCallsFromOutput(cache, normalizeArrayOrNull(event?.response?.output));
    return;
  }
  if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
    recordToolCallItem(cache, event.item);
    return;
  }
  recordToolCallsFromOutput(cache, normalizeArrayOrNull(event.output));
  recordToolCallItem(cache, event.item);
}

function normalizeInitialCreateRequest(rawRequest: JsonRecord): JsonRecord {
  const request = cloneWithoutInternalFields(rawRequest);
  request.stream = true;
  if (!Array.isArray(request.input)) {
    request.input = [];
  }
  if (!normalizeString(request.model)) {
    throw new ResponsesWebSocketRepairError('Missing model in response.create request.');
  }
  return request;
}

function normalizeSubsequentRequest(
  rawRequest: JsonRecord,
  state: ResponsesWebSocketRepairState,
): ResponsesWebSocketNormalizeResult {
  const lastRequest = state.lastRequest;
  if (!lastRequest || typeof lastRequest !== 'object') {
    throw new ResponsesWebSocketRepairError('Websocket request received before response.create.');
  }

  const nextInput = normalizeArrayOrNull(rawRequest?.input);
  if (!nextInput) {
    throw new ResponsesWebSocketRepairError('Websocket request requires array field: input.');
  }

  if (shouldReplaceResponsesWebSocketTranscript(rawRequest)) {
    const request = normalizeTranscriptReplacement(rawRequest, lastRequest);
    return {
      request,
      nextLastRequest: cloneJson(request),
      mode: 'transcript-replacement',
    };
  }

  const allowIncremental = state.allowIncrementalInputWithPreviousResponseID !== false;
  if (allowIncremental && normalizeString(rawRequest?.previous_response_id)) {
    const request = cloneWithoutInternalFields(rawRequest);
    copyPreviousContext(request, lastRequest);
    request.stream = true;
    return {
      request,
      nextLastRequest: cloneJson(request),
      mode: 'incremental',
    };
  }

  const existingInput = Array.isArray(lastRequest.input) ? cloneJson(lastRequest.input) : [];
  const previousOutput = Array.isArray(state.lastResponseOutput) ? cloneJson(state.lastResponseOutput) : [];
  const mergedInput = dedupeToolCallsByCallId([
    ...existingInput,
    ...previousOutput,
    ...cloneJson(nextInput),
  ]);
  const request = cloneWithoutInternalFields(rawRequest);
  delete request.previous_response_id;
  request.input = mergedInput;
  copyPreviousContext(request, lastRequest);
  request.stream = true;
  return {
    request,
    nextLastRequest: cloneJson(request),
    mode: 'merge',
  };
}

function normalizeTranscriptReplacement(rawRequest: JsonRecord, lastRequest: JsonRecord): JsonRecord {
  const request = cloneWithoutInternalFields(rawRequest);
  delete request.previous_response_id;
  copyPreviousContext(request, lastRequest);
  request.stream = true;
  return request;
}

function copyPreviousContext(request: JsonRecord, lastRequest: JsonRecord): void {
  if (!Object.prototype.hasOwnProperty.call(request, 'model') && normalizeString(lastRequest?.model)) {
    request.model = lastRequest.model;
  }
  if (!Object.prototype.hasOwnProperty.call(request, 'instructions') && lastRequest?.instructions !== undefined) {
    request.instructions = cloneJson(lastRequest.instructions);
  }
}

function dedupeToolCallsByCallId(input: JsonRecord[]): JsonRecord[] {
  const seen = new Set<string>();
  const output: JsonRecord[] = [];
  for (const item of input) {
    const type = normalizeString(item?.type);
    const callId = normalizeString(item?.call_id);
    if (isToolCallType(type) && callId) {
      if (seen.has(callId)) {
        continue;
      }
      seen.add(callId);
    }
    output.push(item);
  }
  return output;
}

function recordToolCallsFromOutput(cache: ResponsesWebSocketToolRepairCache, output: JsonRecord[] | null): void {
  if (!output) {
    return;
  }
  for (const item of output) {
    recordToolCallItem(cache, item);
  }
}

function recordToolCallItem(cache: ResponsesWebSocketToolRepairCache, item: unknown): void {
  if (!item || typeof item !== 'object') {
    return;
  }
  const record = item as JsonRecord;
  if (!isToolCallType(normalizeString(record.type))) {
    return;
  }
  const callId = normalizeString(record.call_id);
  if (!callId) {
    return;
  }
  cache.callsByCallId.set(callId, cloneJson(record));
}

function cloneWithoutInternalFields(rawRequest: JsonRecord): JsonRecord {
  const request = cloneJson(rawRequest);
  delete request.type;
  return request;
}

function isToolCallType(type: string): boolean {
  return type === 'function_call' || type === 'custom_tool_call';
}

function isToolOutputType(type: string): boolean {
  return type === 'function_call_output' || type === 'custom_tool_call_output';
}

function normalizeArrayOrNull(value: unknown): JsonRecord[] | null {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object')
    : null;
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function createSyntheticWebSocketCallId(): string {
  return `call_${crypto.randomUUID()}`;
}
