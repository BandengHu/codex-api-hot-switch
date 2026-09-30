import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import {
  chatCompletionsResponseToResponses,
  inspectOpenAICompatiblePayloadCompatibility,
  responsesRequestToCompactionResponse,
  responsesRequestToChatCompletions,
  translateChatCompletionsSseStreamToResponsesSse,
} from '../converters/responses_adapter.js';
import {
  buildOpenAICompatibleCapabilityCatalogMetadata,
} from '../capabilities/capability_presets.js';
import {
  getOpenAICompatibleThinkingPolicy,
  getProviderThinkingSupport,
  resolveOpenAICompatibleProviderCapabilitiesForModel,
  type OpenAICompatibleModelCapabilities,
  OpenAICompatibleProviderCapabilities,
  OpenAICompatibleRetryCapabilities,
} from '../capabilities/thinking_policy.js';
import {
  normalizeCodexProviderRelayHostedTools,
  type CodexProviderRelayHostedToolDeclaration,
  type NormalizedCodexProviderRelayHostedToolDeclaration,
} from '../hosted_tools.js';
import {
  createCodexProviderRelayHostedToolExecutorRegistry,
  formatCodexProviderRelayHostedToolExecutionResult,
  type CodexProviderRelayHostedToolExecutorRegistry,
  type CodexProviderRelayHostedToolExecutorRegistryInput,
} from '../hosted_tool_executors.js';
import {
  isCodexProviderRelayRelayEmulatedBuiltinToolType,
  normalizeCodexProviderRelayBuiltinToolName,
} from '../builtin-tools/index.js';

type JsonRecord = Record<string, any>;
type AdapterRoute = 'responses' | 'responses.compact';
type RelayHostedToolExecutionRecord = {
  toolName: string;
  relayToolName: string;
  callId: string;
  iteration: number;
  arguments: JsonRecord;
  content: string;
  resultContent: unknown;
  resultMetadata: JsonRecord | null;
};
type GatewayErrorCategory =
  | 'authentication'
  | 'rate_limit'
  | 'transient_upstream'
  | 'unsupported_feature'
  | 'not_found'
  | 'invalid_request'
  | 'malformed_upstream'
  | 'upstream_failure';
type GatewayRetryHint =
  | 'check_api_key_or_access'
  | 'respect_retry_after'
  | 'retry_with_backoff'
  | 'remove_or_downgrade_unsupported_feature'
  | 'check_model_or_route'
  | 'fix_request'
  | 'retry_or_inspect_upstream';

type CodexProviderRelayRequestAdjustment =
  | {
    kind: 'field_filtered' | 'tool_choice_dropped' | 'model_overridden';
    path: string;
    reason: string;
    before: unknown;
    after?: unknown;
  }
  | {
    kind: 'tools_dropped' | 'image_input_downgraded' | 'file_input_downgraded';
    path: string;
    reason: string;
    requestedCount: number;
    forwardedCount: number;
    strategy?: string | null;
  }
  | {
    kind: 'max_output_tokens_capped';
    path: 'max_output_tokens';
    reason: 'model_limit';
    before: number;
    after: number;
  };

export type CodexProviderRelayTraceEvent =
  | {
    type: 'request.received';
    route: AdapterRoute;
    model: string;
    stream: boolean;
    request: JsonRecord;
  }
  | {
    type: 'request.translated';
    route: 'responses';
    model: string;
    stream: boolean;
    request: JsonRecord;
    upstreamRequest: JsonRecord;
  }
  | {
    type: 'request.adjusted';
    route: 'responses';
    model: string;
    stream: boolean;
    adjustments: CodexProviderRelayRequestAdjustment[];
  }
  | {
    type: 'response.translated';
    route: 'responses';
    model: string;
    stream: false;
    response: JsonRecord;
  }
  | {
    type: 'response.compaction_fallback';
    route: 'responses.compact';
    model: string;
    reason: 'compact_not_supported';
    response: JsonRecord;
  }
  | {
    type: 'upstream.retry';
    route: AdapterRoute;
    attempt: number;
    nextAttempt: number;
    status: number | null;
    reason: 'network' | 'status';
    delayMs: number;
  }
  | {
    type: 'upstream.error';
    route: AdapterRoute;
    status: number;
    error: JsonRecord;
  }
  | {
    type: 'stream.event';
    route: 'responses';
    event: JsonRecord;
  }
  | {
    type: 'stream.completed';
    route: 'responses';
    eventCount: number;
  }
  | {
    type: 'hosted_tool.executed';
    route: 'responses';
    toolName: string;
    relayToolName: string;
    callId: string;
    iteration: number;
  };

export type CodexProviderRelayTraceSink = (event: CodexProviderRelayTraceEvent) => void;

/**
 * @deprecated Use CodexProviderRelayTraceEvent.
 */
export type CodexGatewayTraceEvent = CodexProviderRelayTraceEvent;

/**
 * @deprecated Use CodexProviderRelayTraceSink.
 */
export type CodexGatewayTraceSink = CodexProviderRelayTraceSink;

export interface OpenAICompatibleResponsesAdapterServerOptions {
  apiKey: string;
  upstreamBaseUrl?: string | null;
  defaultModel?: string | null;
  models?: Array<Record<string, any> & { id?: string; model?: string; slug?: string; object?: string; created?: number; owned_by?: string }>;
  fetchImpl?: typeof fetch;
  host?: string;
  port?: number;
  providerKind?: string | null;
  providerName?: string | null;
  providerCapabilities?: OpenAICompatibleProviderCapabilities | null;
  upstreamResponsesPath?: string | null;
  upstreamChatCompletionsPath?: string | null;
  ownedBy?: string | null;
  traceSink?: CodexProviderRelayTraceSink | null;
  hostedTools?: CodexProviderRelayHostedToolDeclaration[] | null;
  hostedToolExecutors?: CodexProviderRelayHostedToolExecutorRegistryInput;
  maxHostedToolIterations?: number | null;
  emitHostedToolSseEvents?: boolean | null;
  exposeHostedToolResultsInResponsesOutput?: boolean | null;
}

const DEFAULT_UPSTREAM_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.4';
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETRY_STATUSES = [403, 408, 429, 500, 502, 503, 504];

export class OpenAICompatibleResponsesAdapterServer {
  private readonly apiKey: string;

  private readonly upstreamBaseUrl: string;

  private readonly defaultModel: string;

  private readonly models: Array<{ id: string; slug: string; object: string; created: number; owned_by: string }>;

  private readonly fetchImpl: typeof fetch;

  private readonly host: string;

  private readonly requestedPort: number;

  private readonly providerKind: string;

  private readonly providerName: string;

  private readonly providerCapabilities: OpenAICompatibleProviderCapabilities | null;

  private readonly upstreamResponsesPath: string | null;

  private readonly upstreamChatCompletionsPath: string;

  private readonly ownedBy: string;

  private readonly traceSink: CodexProviderRelayTraceSink | null;

  private readonly hostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[];

  private readonly executableHostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[];

  private readonly hostedToolExecutorRegistry: CodexProviderRelayHostedToolExecutorRegistry;

  private readonly maxHostedToolIterations: number;

  private readonly emitHostedToolSseEvents: boolean;

  private readonly exposeHostedToolResultsInResponsesOutput: boolean;

  private server: http.Server | null;

  private startedUrl: string | null;

  constructor({
    apiKey,
    upstreamBaseUrl = DEFAULT_UPSTREAM_BASE_URL,
    defaultModel = DEFAULT_MODEL,
    models = [],
    fetchImpl = fetch,
    host = '127.0.0.1',
    port = 0,
    providerKind = 'openai-compatible',
    providerName = 'OpenAI Compatible',
    providerCapabilities = null,
    upstreamResponsesPath = null,
    upstreamChatCompletionsPath = '/chat/completions',
    ownedBy = 'openai-compatible',
    traceSink = null,
    hostedTools = null,
    hostedToolExecutors = null,
    maxHostedToolIterations = null,
    emitHostedToolSseEvents = false,
    exposeHostedToolResultsInResponsesOutput = false,
  }: OpenAICompatibleResponsesAdapterServerOptions) {
    const normalizedKey = normalizeString(apiKey);
    if (!normalizedKey) {
      throw new Error(`${normalizeString(providerName) || 'OpenAI-compatible'} adapter requires an API key.`);
    }
    this.apiKey = normalizedKey;
    this.upstreamBaseUrl = normalizeString(upstreamBaseUrl) || DEFAULT_UPSTREAM_BASE_URL;
    this.defaultModel = normalizeString(defaultModel) || DEFAULT_MODEL;
    this.providerKind = normalizeString(providerKind) || 'openai-compatible';
    this.providerName = normalizeString(providerName) || 'OpenAI Compatible';
    this.providerCapabilities = providerCapabilities && typeof providerCapabilities === 'object'
      ? JSON.parse(JSON.stringify(providerCapabilities))
      : null;
    this.upstreamResponsesPath = normalizePath(upstreamResponsesPath)
      || normalizePath(this.providerCapabilities?.upstreamResponsesPath)
      || null;
    this.upstreamChatCompletionsPath = normalizePath(upstreamChatCompletionsPath) || '/chat/completions';
    this.ownedBy = normalizeString(ownedBy) || this.providerKind;
    this.traceSink = typeof traceSink === 'function' ? traceSink : null;
    this.hostedTools = normalizeCodexProviderRelayHostedTools(hostedTools);
    this.hostedToolExecutorRegistry = createCodexProviderRelayHostedToolExecutorRegistry(hostedToolExecutors);
    this.executableHostedTools = this.hostedTools.filter((tool) => (
      tool.mode !== 'relay-emulated'
      || this.hostedToolExecutorRegistry.has(tool.name)
    ));
    this.maxHostedToolIterations = normalizePositiveInteger(maxHostedToolIterations) ?? 4;
    this.emitHostedToolSseEvents = Boolean(emitHostedToolSseEvents);
    this.exposeHostedToolResultsInResponsesOutput = Boolean(exposeHostedToolResultsInResponsesOutput);
    this.models = normalizeModels(
      models,
      this.defaultModel,
      this.ownedBy,
      this.providerKind,
      this.providerCapabilities,
    );
    this.fetchImpl = fetchImpl;
    this.host = host;
    this.requestedPort = port;
    this.server = null;
    this.startedUrl = null;
  }

  get baseUrl(): string {
    if (!this.startedUrl) {
      throw new Error(`${this.providerName} adapter server has not been started.`);
    }
    return this.startedUrl;
  }

  async start(): Promise<void> {
    if (this.server && this.startedUrl) {
      return;
    }
    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error) => {
        writeJson(response, 500, {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: 'adapter_error',
          },
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off('error', onError);
        const address = this.server?.address();
        const port = typeof address === 'object' && address ? address.port : this.requestedPort;
        this.startedUrl = `http://${this.host}:${port}`;
        resolve();
      };
      this.server?.once('error', onError);
      this.server?.once('listening', onListening);
      this.server?.listen(this.requestedPort, this.host);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.startedUrl = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }).catch(() => {});
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && isModelsPath(url.pathname)) {
      writeJson(response, 200, {
        object: 'list',
        data: this.models,
        models: this.models,
        meta: buildModelsResponseMetadata({
          defaultModel: this.defaultModel,
          ownedBy: this.ownedBy,
          providerKind: this.providerKind,
          providerName: this.providerName,
          providerCapabilities: this.providerCapabilities,
          upstreamChatCompletionsPath: this.upstreamChatCompletionsPath,
        }),
      });
      return;
    }
    if (request.method === 'POST' && isResponsesPath(url.pathname)) {
      const body = await readJsonBody(request);
      await this.handleResponses(body, response, {
        compact: isResponsesCompactPath(url.pathname),
      });
      return;
    }
    writeJson(response, 404, {
      error: {
        message: `Unsupported ${this.providerName} adapter route: ${request.method} ${url.pathname}`,
        type: 'not_found',
      },
    });
  }

  private async handleResponses(
    requestBody: JsonRecord,
    response: ServerResponse,
    { compact = false }: { compact?: boolean } = {},
  ): Promise<void> {
    const route: AdapterRoute = compact ? 'responses.compact' : 'responses';
    const requestedModel = normalizeString(requestBody?.model) || this.defaultModel;
    const effectiveCapabilities = resolveOpenAICompatibleProviderCapabilitiesForModel(
      this.providerCapabilities,
      requestedModel,
    );
    const stream = Boolean(requestBody?.stream);
    this.emitTrace({
      type: 'request.received',
      route,
      model: requestedModel,
      stream,
      request: requestBody,
    });
    if (compact) {
      await this.handleCompactResponses(requestBody, response, effectiveCapabilities);
      return;
    }
    if (this.upstreamResponsesPath) {
      await this.handleDirectResponsesProxy(
        requestBody,
        response,
        requestedModel,
        stream,
        route,
        effectiveCapabilities,
      );
      return;
    }
    const relayHostedToolExecutionRequired = requestUsesExecutableRelayHostedTool(
      requestBody,
      this.executableHostedTools,
    );
    const upstreamStream = stream;
    const chatBody = responsesRequestToChatCompletions(requestBody, {
      model: requestedModel,
      stream: upstreamStream,
      providerKind: this.providerKind,
      providerCapabilities: effectiveCapabilities,
      hostedTools: this.executableHostedTools,
    });
    this.emitTrace({
      type: 'request.translated',
      route: 'responses',
      model: requestedModel,
      stream,
      request: requestBody,
      upstreamRequest: chatBody,
    });
    const adjustments = summarizeRequestAdjustments({
      request: requestBody,
      upstreamRequest: chatBody,
      providerCapabilities: effectiveCapabilities,
      hostedTools: this.executableHostedTools,
    });
    if (adjustments.length > 0) {
      this.emitTrace({
        type: 'request.adjusted',
        route: 'responses',
        model: requestedModel,
        stream,
        adjustments,
      });
    }
    if (upstreamStream) {
      chatBody.stream_options = {
        ...(chatBody.stream_options && typeof chatBody.stream_options === 'object' ? chatBody.stream_options : {}),
        include_usage: true,
      };
    }
    const upstreamUrl = buildChatCompletionsUrl(this.upstreamBaseUrl, this.upstreamChatCompletionsPath);
    const buildUpstreamInit = (body: JsonRecord): RequestInit => ({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: body?.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (stream && relayHostedToolExecutionRequired) {
      await this.writeRelayHostedToolStreamingResponse({
        requestBody,
        chatBody,
        upstreamUrl,
        buildUpstreamInit,
        providerCapabilities: effectiveCapabilities,
        requestedModel,
        response,
      });
      return;
    }
    let upstream = await this.fetchUpstreamWithRetry(
      upstreamUrl,
      buildUpstreamInit(chatBody),
      'responses',
      effectiveCapabilities,
    );
    if (shouldRetryWithoutForcedToolChoice(chatBody, upstream)) {
      const downgradedChatBody = {
        ...chatBody,
      };
      const before = downgradedChatBody.tool_choice;
      delete downgradedChatBody.tool_choice;
      this.emitTrace({
        type: 'request.adjusted',
        route: 'responses',
        model: requestedModel,
        stream,
        adjustments: [{
          kind: 'tool_choice_dropped',
          path: 'tool_choice',
          reason: 'upstream_rejected_forced_tool_choice',
          before,
        }],
      });
      this.emitTrace({
        type: 'upstream.retry',
        route: 'responses',
        attempt: 1,
        nextAttempt: 2,
        status: upstream.response.status || null,
        reason: 'status',
        delayMs: 0,
      });
      upstream = await this.fetchUpstreamWithRetry(
        upstreamUrl,
        buildUpstreamInit(downgradedChatBody),
        'responses',
        effectiveCapabilities,
      );
    }
    if (!upstream.response.ok) {
      const error = normalizeUpstreamError(
        upstream.errorText ?? '',
        this.providerName,
        upstream.response.status,
        upstream.response.headers,
      );
      this.emitTrace({
        type: 'upstream.error',
        route: 'responses',
        status: upstream.response.status || 502,
        error,
      });
      writeJson(response, upstream.response.status || 502, { error });
      return;
    }
    if (upstreamStream) {
      await this.writeStreamingResponse(requestBody, effectiveCapabilities, upstream.response, response);
      return;
    }
    let json = await upstream.response.json() as JsonRecord;
    if (!json || typeof json !== 'object') {
      const error = buildMalformedUpstreamPayloadError(
        this.providerName,
        'non_object_json_response',
      );
      this.emitTrace({
        type: 'upstream.error',
        route: 'responses',
        status: 502,
        error,
      });
      writeJson(response, 502, { error });
      return;
    }
    const hostedToolLoop = await this.completeRelayHostedToolLoop({
      requestBody,
      chatBody,
      initialJson: json,
      upstreamUrl,
      buildUpstreamInit,
      providerCapabilities: effectiveCapabilities,
      requestedModel,
    });
    if (hostedToolLoop.error) {
      this.emitTrace({
        type: 'upstream.error',
        route: 'responses',
        status: hostedToolLoop.status,
        error: hostedToolLoop.error,
      });
      writeJson(response, hostedToolLoop.status, { error: hostedToolLoop.error });
      return;
    }
    json = hostedToolLoop.json;
    try {
      const modelMetadata = resolveModelMetadata(
        this.models,
        normalizeString(requestBody?.model) || normalizeString(json?.model) || this.defaultModel,
      );
      const adaptedResponse = chatCompletionsResponseToResponses(json, {
        request: requestBody,
        providerCapabilities: effectiveCapabilities,
        modelMetadata,
      });
      appendHostedToolResultsToResponsesOutput({
        response: adaptedResponse,
        request: requestBody,
        executions: hostedToolLoop.executions,
        exposeByDefault: this.exposeHostedToolResultsInResponsesOutput,
      });
      this.emitTrace({
        type: 'response.translated',
        route: 'responses',
        model: requestedModel,
        stream: false,
        response: adaptedResponse,
      });
      if (stream && relayHostedToolExecutionRequired) {
        await this.writeSyntheticStreamingResponse(adaptedResponse, response);
        return;
      }
      writeJson(response, 200, adaptedResponse);
    } catch (error) {
      const malformedError = buildMalformedUpstreamPayloadError(
        this.providerName,
        error instanceof Error ? error.message : String(error),
      );
      this.emitTrace({
        type: 'upstream.error',
        route: 'responses',
        status: 502,
        error: malformedError,
      });
      writeJson(response, 502, { error: malformedError });
    }
  }

  private async handleDirectResponsesProxy(
    requestBody: JsonRecord,
    response: ServerResponse,
    requestedModel: string,
    stream: boolean,
    route: AdapterRoute,
    providerCapabilities: OpenAICompatibleProviderCapabilities | null,
  ): Promise<void> {
    this.emitTrace({
      type: 'request.translated',
      route: 'responses',
      model: requestedModel,
      stream,
      request: requestBody,
      upstreamRequest: requestBody,
    });
    const upstream = await this.fetchUpstreamWithRetry(
      buildChatCompletionsUrl(this.upstreamBaseUrl, this.upstreamResponsesPath),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(requestBody),
      },
      route,
      providerCapabilities,
    );
    if (!upstream.response.ok) {
      const error = normalizeUpstreamError(
        upstream.errorText ?? '',
        this.providerName,
        upstream.response.status,
        upstream.response.headers,
      );
      this.emitTrace({
        type: 'upstream.error',
        route,
        status: upstream.response.status || 502,
        error,
      });
      writeJson(response, upstream.response.status || 502, { error });
      return;
    }
    if (stream) {
      await this.pipeUpstreamStream(upstream.response, response);
      return;
    }
    const text = await upstream.response.text();
    const contentType = upstream.response.headers.get('Content-Type') || 'application/json; charset=utf-8';
    try {
      const json = JSON.parse(text) as JsonRecord;
      this.emitTrace({
        type: 'response.translated',
        route: 'responses',
        model: requestedModel,
        stream: false,
        response: json,
      });
      writeJson(response, 200, json);
      return;
    } catch {
      response.writeHead(200, {
        'Content-Type': contentType,
      });
      response.end(text);
    }
  }

  private async completeRelayHostedToolLoop({
    requestBody,
    chatBody,
    initialJson,
    upstreamUrl,
    buildUpstreamInit,
    providerCapabilities,
    requestedModel,
  }: {
    requestBody: JsonRecord;
    chatBody: JsonRecord;
    initialJson: JsonRecord;
    upstreamUrl: string;
    buildUpstreamInit: (body: JsonRecord) => RequestInit;
    providerCapabilities: OpenAICompatibleProviderCapabilities | null;
    requestedModel: string;
  }): Promise<{
    json: JsonRecord;
    status: number;
    error: JsonRecord | null;
    executions: RelayHostedToolExecutionRecord[];
  }> {
    if (this.executableHostedTools.length === 0) {
      return {
        json: initialJson,
        status: 200,
        error: null,
        executions: [],
      };
    }

    let currentJson = initialJson;
    const executions: RelayHostedToolExecutionRecord[] = [];
    const loopChatBody = cloneJson(chatBody);
    for (let iteration = 1; iteration <= this.maxHostedToolIterations; iteration += 1) {
      const executableCalls = collectRelayHostedToolCalls(
        currentJson,
        this.executableHostedTools,
        this.hostedToolExecutorRegistry,
      );
      if (executableCalls.length === 0) {
        return {
          json: currentJson,
          status: 200,
          error: null,
          executions,
        };
      }

      for (const { message, toolCalls } of groupRelayHostedToolCallsByMessage(executableCalls)) {
        loopChatBody.messages.push(buildAssistantToolCallMessage(message, toolCalls.map((entry) => entry.toolCall)));
        for (const entry of toolCalls) {
          const executionResult = await this.executeRelayHostedToolCall(
            entry,
            iteration,
            requestedModel,
          );
          executions.push(executionResult);
          loopChatBody.messages.push({
            role: 'tool',
            tool_call_id: executionResult.callId,
            content: executionResult.content,
          });
          appendDeferredToolsFromToolSearch(loopChatBody, executionResult);
        }
      }

      const upstream = await this.fetchUpstreamWithRetry(
        upstreamUrl,
        buildUpstreamInit(loopChatBody),
        'responses',
        providerCapabilities,
      );
      if (!upstream.response.ok) {
        return {
          json: currentJson,
          status: upstream.response.status || 502,
          error: normalizeUpstreamError(
            upstream.errorText ?? '',
            this.providerName,
            upstream.response.status,
            upstream.response.headers,
          ),
          executions,
        };
      }
      currentJson = await upstream.response.json() as JsonRecord;
      if (!currentJson || typeof currentJson !== 'object') {
        return {
          json: currentJson,
          status: 502,
          error: buildMalformedUpstreamPayloadError(
            this.providerName,
            'non_object_json_response_after_hosted_tool_execution',
          ),
          executions,
        };
      }
    }

    return {
      json: currentJson,
      status: 502,
      error: {
        message: `Relay-emulated hosted tool loop exceeded ${this.maxHostedToolIterations} iterations.`,
        type: 'unsupported_feature',
        code: 'hosted_tool_loop_exceeded',
      },
      executions,
    };
  }

  private async writeRelayHostedToolStreamingResponse({
    requestBody,
    chatBody,
    upstreamUrl,
    buildUpstreamInit,
    providerCapabilities,
    requestedModel,
    response,
  }: {
    requestBody: JsonRecord;
    chatBody: JsonRecord;
    upstreamUrl: string;
    buildUpstreamInit: (body: JsonRecord) => RequestInit;
    providerCapabilities: OpenAICompatibleProviderCapabilities | null;
    requestedModel: string;
    response: ServerResponse;
  }): Promise<void> {
    const loopChatBody = cloneJson(chatBody);
    loopChatBody.stream = true;
    loopChatBody.stream_options = {
      ...(loopChatBody.stream_options && typeof loopChatBody.stream_options === 'object' ? loopChatBody.stream_options : {}),
      include_usage: true,
    };

    for (let iteration = 1; iteration <= this.maxHostedToolIterations; iteration += 1) {
      let upstream = await this.fetchUpstreamWithRetry(
        upstreamUrl,
        buildUpstreamInit(loopChatBody),
        'responses',
        providerCapabilities,
      );
      if (shouldRetryWithoutForcedToolChoice(loopChatBody, upstream)) {
        const before = loopChatBody.tool_choice;
        delete loopChatBody.tool_choice;
        this.emitTrace({
          type: 'request.adjusted',
          route: 'responses',
          model: requestedModel,
          stream: true,
          adjustments: [{
            kind: 'tool_choice_dropped',
            path: 'tool_choice',
            reason: 'upstream_rejected_forced_tool_choice',
            before,
          }],
        });
        this.emitTrace({
          type: 'upstream.retry',
          route: 'responses',
          attempt: 1,
          nextAttempt: 2,
          status: upstream.response.status || null,
          reason: 'status',
          delayMs: 0,
        });
        upstream = await this.fetchUpstreamWithRetry(
          upstreamUrl,
          buildUpstreamInit(loopChatBody),
          'responses',
          providerCapabilities,
        );
      }
      if (!upstream.response.ok) {
        const error = normalizeUpstreamError(
          upstream.errorText ?? '',
          this.providerName,
          upstream.response.status,
          upstream.response.headers,
        );
        this.emitTrace({
          type: 'upstream.error',
          route: 'responses',
          status: upstream.response.status || 502,
          error,
        });
        writeJson(response, upstream.response.status || 502, { error });
        return;
      }
      if (!upstream.response.body) {
        writeJson(response, 502, {
          error: {
            message: `${this.providerName} upstream returned no stream body.`,
            type: 'upstream_error',
          },
        });
        return;
      }

      const decision = await inspectRelayHostedStreamingTurn(
        readSseDataLines(upstream.response.body),
        this.executableHostedTools,
        this.hostedToolExecutorRegistry,
      );
      if (decision.kind === 'final_stream') {
        await this.writeStreamingDataLinesResponse(
          requestBody,
          providerCapabilities,
          chainSseDataLines(decision.bufferedChunks, decision.remaining),
          response,
        );
        return;
      }
      if (decision.kind === 'error') {
        writeJson(response, 502, {
          error: {
            message: decision.message,
            type: 'unsupported_feature',
            code: 'relay_hosted_streaming_tool_mix_unsupported',
          },
        });
        return;
      }

      loopChatBody.messages.push(buildAssistantToolCallMessage({
        content: '',
      }, decision.calls.map((entry) => entry.toolCall)));
      for (const entry of decision.calls) {
        const executionResult = await this.executeRelayHostedToolCall(
          entry,
          iteration,
          requestedModel,
          {
            emitSseEvent: this.emitHostedToolSseEvents
              ? (event) => {
                ensureSseResponseHeaders(response);
                response.write(formatResponsesSseEvent(event));
                this.emitTrace({
                  type: 'stream.event',
                  route: 'responses',
                  event,
                });
              }
              : null,
          },
        );
        loopChatBody.messages.push({
          role: 'tool',
          tool_call_id: executionResult.callId,
          content: executionResult.content,
        });
        appendDeferredToolsFromToolSearch(loopChatBody, executionResult);
      }
    }

    writeJson(response, 502, {
      error: {
        message: `Relay-emulated hosted tool streaming loop exceeded ${this.maxHostedToolIterations} iterations.`,
        type: 'unsupported_feature',
        code: 'hosted_tool_streaming_loop_exceeded',
      },
    });
  }

  private async executeRelayHostedToolCall(
    entry: RelayHostedToolCall,
    iteration: number,
    requestedModel: string,
    observation: {
      emitSseEvent?: ((event: JsonRecord) => void) | null;
    } = {},
  ): Promise<{
    callId: string;
    content: string;
    toolName: string;
    relayToolName: string;
    iteration: number;
    arguments: JsonRecord;
    resultContent: unknown;
    resultMetadata: JsonRecord | null;
  }> {
    const callId = normalizeString(entry.toolCall?.id) || `call_${iteration}`;
    const relayToolName = normalizeString(entry.toolCall?.function?.name)
      || normalizeString(entry.declaration.relayToolName)
      || entry.declaration.name;
    const rawArguments = normalizeString(entry.toolCall?.function?.arguments) || '{}';
    let content: string;
    let resultContent: unknown = null;
    let resultMetadata: JsonRecord | null = null;
    const startedAt = Date.now();
    const emitSseEvent = typeof observation.emitSseEvent === 'function'
      ? observation.emitSseEvent
      : null;
    emitSseEvent?.(buildHostedToolSseEvent({
      type: 'hosted_tool.started',
      entry,
      relayToolName,
      callId,
      iteration,
      startedAt,
      argumentsObject: parseToolCallArguments(rawArguments),
    }));
    const argumentsObject = parseToolCallArguments(rawArguments);
    try {
      const result = await this.hostedToolExecutorRegistry.execute({
        toolName: entry.declaration.name,
        relayToolName,
        callId,
        arguments: argumentsObject,
        rawArguments,
        model: requestedModel || null,
        providerKind: this.providerKind,
        providerName: this.providerName,
        emitDelta: emitSseEvent
          ? async (delta, metadata = null) => {
            emitSseEvent(buildHostedToolSseEvent({
              type: 'hosted_tool.delta',
              entry,
              relayToolName,
              callId,
              iteration,
              startedAt,
              delta,
              metadata,
            }));
          }
          : null,
      });
      resultContent = result.content ?? null;
      resultMetadata = result.metadata ?? null;
      content = formatCodexProviderRelayHostedToolExecutionResult(result);
      emitSseEvent?.(buildHostedToolSseEvent({
        type: 'hosted_tool.completed',
        entry,
        relayToolName,
        callId,
        iteration,
        startedAt,
        durationMs: Date.now() - startedAt,
        metadata: result.metadata ?? null,
        outputPreview: hostedToolOutputPreview(content),
      }));
    } catch (error) {
      resultContent = {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'hosted_tool_execution_error',
        },
      };
      content = JSON.stringify(resultContent);
      emitSseEvent?.(buildHostedToolSseEvent({
        type: 'hosted_tool.failed',
        entry,
        relayToolName,
        callId,
        iteration,
        startedAt,
        durationMs: Date.now() - startedAt,
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: 'hosted_tool_execution_error',
        },
      }));
    }

    this.emitTrace({
      type: 'hosted_tool.executed',
      route: 'responses',
      toolName: entry.declaration.name,
      relayToolName,
      callId,
      iteration,
    });
    return {
      callId,
      content,
      toolName: entry.declaration.name,
      relayToolName,
      iteration,
      arguments: argumentsObject,
      resultContent,
      resultMetadata,
    };
  }

  private async handleCompactResponses(
    requestBody: JsonRecord,
    response: ServerResponse,
    providerCapabilities: OpenAICompatibleProviderCapabilities | null,
  ): Promise<void> {
    if (Boolean(requestBody?.stream)) {
      writeJson(response, 400, {
        error: {
          message: 'Streaming not supported for compact responses',
          type: 'invalid_request_error',
        },
      });
      return;
    }
    const compactBody = { ...requestBody };
    delete compactBody.stream;

    if (!providerCapabilities?.supportsResponsesCompact) {
      const modelMetadata = resolveModelMetadata(
        this.models,
        normalizeString(compactBody?.model) || this.defaultModel,
      );
      const compactResponse = responsesRequestToCompactionResponse(compactBody, {
        request: compactBody,
        providerCapabilities,
        modelMetadata,
      });
      this.emitTrace({
        type: 'response.compaction_fallback',
        route: 'responses.compact',
        model: normalizeString(compactBody?.model) || this.defaultModel,
        reason: 'compact_not_supported',
        response: compactResponse,
      });
      writeJson(response, 200, compactResponse);
      return;
    }

    const compactPath = normalizePath(providerCapabilities.upstreamResponsesCompactPath) || '/responses/compact';
    const upstream = await this.fetchUpstreamWithRetry(
      buildChatCompletionsUrl(this.upstreamBaseUrl, compactPath),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(compactBody),
      },
      'responses.compact',
      providerCapabilities,
    );
    if (!upstream.response.ok) {
      const error = normalizeUpstreamError(
        upstream.errorText ?? '',
        this.providerName,
        upstream.response.status,
        upstream.response.headers,
      );
      this.emitTrace({
        type: 'upstream.error',
        route: 'responses.compact',
        status: upstream.response.status || 502,
        error,
      });
      writeJson(response, upstream.response.status || 502, { error });
      return;
    }
    const text = await upstream.response.text();
    response.writeHead(200, {
      'Content-Type': upstream.response.headers.get('Content-Type') || 'application/json; charset=utf-8',
    });
    response.end(text);
  }

  private async fetchUpstreamWithRetry(
    url: string,
    init: RequestInit,
    route: AdapterRoute,
    providerCapabilities: OpenAICompatibleProviderCapabilities | null,
  ): Promise<{
    response: Response;
    errorText: string | null;
  }> {
    const retry = normalizeRetryCapabilities(providerCapabilities?.retry);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      let upstream: Response;
      try {
        upstream = await this.fetchImpl(url, init);
      } catch (error) {
        lastError = error;
        if (attempt < retry.maxAttempts && retry.retryNetworkErrors) {
          const delayMs = resolveRetryDelayMs(null, '', attempt, retry);
          this.emitTrace({
            type: 'upstream.retry',
            route,
            attempt,
            nextAttempt: attempt + 1,
            status: null,
            reason: 'network',
            delayMs,
          });
          await sleep(delayMs);
          continue;
        }
        throw error;
      }
      if (upstream.ok || attempt >= retry.maxAttempts || !retry.retryStatuses.has(upstream.status)) {
        return {
          response: upstream,
          errorText: upstream.ok ? null : await upstream.text().catch(() => ''),
        };
      }
      const text = await upstream.text().catch(() => '');
      const delayMs = resolveRetryDelayMs(upstream.headers, text, attempt, retry);
      this.emitTrace({
        type: 'upstream.retry',
        route,
        attempt,
        nextAttempt: attempt + 1,
        status: upstream.status,
        reason: 'status',
        delayMs,
      });
      await sleep(delayMs);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'OpenAI-compatible upstream retry failed.'));
  }

  private async pipeUpstreamStream(
    upstreamResponse: Response,
    response: ServerResponse,
  ): Promise<void> {
    response.writeHead(200, {
      'Content-Type': upstreamResponse.headers.get('Content-Type') || 'text/event-stream; charset=utf-8',
      'Cache-Control': upstreamResponse.headers.get('Cache-Control') || 'no-cache',
      Connection: upstreamResponse.headers.get('Connection') || 'keep-alive',
    });
    if (!upstreamResponse.body) {
      response.end();
      return;
    }
    const readable = Readable.fromWeb(upstreamResponse.body as any);
    for await (const chunk of readable) {
      response.write(chunk);
    }
    response.end();
  }

  private async writeStreamingResponse(
    requestBody: JsonRecord,
    providerCapabilities: OpenAICompatibleProviderCapabilities | null,
    upstream: Response,
    response: ServerResponse,
  ): Promise<void> {
    if (!upstream.body) {
      writeJson(response, 502, {
        error: {
          message: `${this.providerName} upstream returned no stream body.`,
          type: 'upstream_error',
        },
      });
      return;
    }
    await this.writeStreamingDataLinesResponse(
      requestBody,
      providerCapabilities,
      readSseDataLines(upstream.body),
      response,
    );
  }

  private async writeStreamingDataLinesResponse(
    requestBody: JsonRecord,
    providerCapabilities: OpenAICompatibleProviderCapabilities | null,
    dataLines: AsyncIterable<string>,
    response: ServerResponse,
  ): Promise<void> {
    ensureSseResponseHeaders(response);
    let eventCount = 0;
    for await (const event of translateChatCompletionsSseStreamToResponsesSse(
      dataLines,
      {
        request: requestBody,
        providerCapabilities,
        modelMetadata: resolveModelMetadata(
          this.models,
          normalizeString(requestBody?.model) || this.defaultModel,
        ),
        traceEvent: (traceEvent) => {
          eventCount += 1;
          this.emitTrace({
            type: 'stream.event',
            route: 'responses',
            event: traceEvent,
          });
        },
      },
    )) {
      response.write(event);
    }
    this.emitTrace({
      type: 'stream.completed',
      route: 'responses',
      eventCount,
    });
    response.end();
  }

  private async writeSyntheticStreamingResponse(
    adaptedResponse: JsonRecord,
    response: ServerResponse,
  ): Promise<void> {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let eventCount = 0;
    for (const event of responsesObjectToSyntheticSseEvents(adaptedResponse)) {
      eventCount += 1;
      this.emitTrace({
        type: 'stream.event',
        route: 'responses',
        event,
      });
      response.write(formatResponsesSseEvent(event));
    }
    response.write('data: [DONE]\n\n');
    this.emitTrace({
      type: 'stream.completed',
      route: 'responses',
      eventCount,
    });
    response.end();
  }

  private emitTrace(event: CodexProviderRelayTraceEvent): void {
    if (!this.traceSink) {
      return;
    }
    try {
      this.traceSink(event);
    } catch {
      // Ignore trace sink failures so protocol serving stays unaffected.
    }
  }
}

interface RelayHostedToolCall {
  declaration: NormalizedCodexProviderRelayHostedToolDeclaration;
  toolCall: JsonRecord;
  message: JsonRecord;
}

type RelayHostedStreamingDecision =
  | {
    kind: 'final_stream';
    bufferedChunks: string[];
    remaining: AsyncIterable<string>;
  }
  | {
    kind: 'tool_calls';
    calls: RelayHostedToolCall[];
  }
  | {
    kind: 'error';
    message: string;
  };

interface StreamingToolCallAccumulator {
  toolCallsByKey: Map<string, JsonRecord>;
  sawToolCallDelta: boolean;
}

async function inspectRelayHostedStreamingTurn(
  dataLines: AsyncIterable<string>,
  hostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[],
  registry: CodexProviderRelayHostedToolExecutorRegistry,
): Promise<RelayHostedStreamingDecision> {
  const iterator = dataLines[Symbol.asyncIterator]();
  const bufferedChunks: string[] = [];
  const accumulator: StreamingToolCallAccumulator = {
    toolCallsByKey: new Map(),
    sawToolCallDelta: false,
  };

  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        return streamingDecisionFromBufferedChunks(bufferedChunks, accumulator, hostedTools, registry);
      }
      const data = next.value;
      bufferedChunks.push(data);
      const chunk = parseChatStreamData(data);
      if (!chunk) {
        continue;
      }
      collectStreamingToolCallDeltas(chunk, accumulator);
      if (!accumulator.sawToolCallDelta && chatStreamChunkHasAssistantText(chunk)) {
        return {
          kind: 'final_stream',
          bufferedChunks,
          remaining: asyncIteratorToIterable(iterator),
        };
      }
      if (accumulator.sawToolCallDelta && chatStreamChunkFinishedToolCalls(chunk)) {
        await drainAsyncIterator(iterator);
        return streamingDecisionFromBufferedChunks(bufferedChunks, accumulator, hostedTools, registry);
      }
    }
  } catch (error) {
    return {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function streamingDecisionFromBufferedChunks(
  bufferedChunks: string[],
  accumulator: StreamingToolCallAccumulator,
  hostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[],
  registry: CodexProviderRelayHostedToolExecutorRegistry,
): RelayHostedStreamingDecision {
  const toolCalls = [...accumulator.toolCallsByKey.values()];
  if (toolCalls.length === 0) {
    return {
      kind: 'final_stream',
      bufferedChunks,
      remaining: emptyAsyncIterable(),
    };
  }

  const fakeMessage = {
    content: '',
    tool_calls: toolCalls,
  };
  const executableCalls = collectRelayHostedToolCalls(
    {
      choices: [{
        message: fakeMessage,
      }],
    },
    hostedTools,
    registry,
  );
  if (executableCalls.length === 0) {
    return {
      kind: 'final_stream',
      bufferedChunks,
      remaining: emptyAsyncIterable(),
    };
  }
  if (executableCalls.length !== toolCalls.length) {
    return {
      kind: 'error',
      message: 'A streamed assistant turn mixed relay-emulated hosted tool calls with non-relay tool calls. This is not supported yet.',
    };
  }
  return {
    kind: 'tool_calls',
    calls: executableCalls,
  };
}

function collectRelayHostedToolCalls(
  chatResponse: JsonRecord,
  hostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[],
  registry: CodexProviderRelayHostedToolExecutorRegistry,
): RelayHostedToolCall[] {
  const calls: RelayHostedToolCall[] = [];
  for (const choice of normalizeArray(chatResponse?.choices)) {
    const message = choice?.message;
    if (!message || typeof message !== 'object') {
      continue;
    }
    for (const toolCall of normalizeArray(message.tool_calls)) {
      const relayToolName = normalizeString(toolCall?.function?.name);
      if (!relayToolName) {
        continue;
      }
      const declaration = hostedTools.find((tool) => (
        tool.mode === 'relay-emulated'
        && normalizeString(tool.relayToolName || tool.name) === relayToolName
      ));
      if (!declaration || !registry.has(declaration.name)) {
        continue;
      }
      calls.push({
        declaration,
        toolCall,
        message,
      });
    }
  }
  return calls;
}

function groupRelayHostedToolCallsByMessage(
  calls: RelayHostedToolCall[],
): Array<{ message: JsonRecord; toolCalls: RelayHostedToolCall[] }> {
  const grouped = new Map<JsonRecord, RelayHostedToolCall[]>();
  for (const call of calls) {
    const existing = grouped.get(call.message);
    if (existing) {
      existing.push(call);
    } else {
      grouped.set(call.message, [call]);
    }
  }
  return [...grouped.entries()].map(([message, toolCalls]) => ({ message, toolCalls }));
}

function buildAssistantToolCallMessage(
  message: JsonRecord,
  toolCalls: JsonRecord[],
): JsonRecord {
  return omitUndefined({
    role: 'assistant',
    content: typeof message?.content === 'string' ? message.content : '',
    tool_calls: toolCalls.map((toolCall) => cloneJson(toolCall)),
  });
}

function appendDeferredToolsFromToolSearch(
  chatBody: JsonRecord,
  execution: RelayHostedToolExecutionRecord,
): void {
  if (normalizeCodexProviderRelayBuiltinToolName(execution.toolName) !== 'tool_search') {
    return;
  }
  const deferredTools = normalizeDeferredToolSearchChatTools(execution.resultContent);
  if (deferredTools.length === 0) {
    return;
  }
  const existingTools = Array.isArray(chatBody.tools) ? chatBody.tools : [];
  const existingNames = new Set(
    existingTools
      .map((tool) => normalizeString((tool as JsonRecord | null | undefined)?.function?.name))
      .filter(Boolean),
  );
  const nextTools = [...existingTools];
  for (const tool of deferredTools) {
    const name = normalizeString(tool.function?.name);
    if (!name || existingNames.has(name)) {
      continue;
    }
    existingNames.add(name);
    nextTools.push(tool);
  }
  chatBody.tools = nextTools;
  delete chatBody.tool_choice;
}

function normalizeDeferredToolSearchChatTools(value: unknown): JsonRecord[] {
  const payload = unwrapDeferredToolSearchPayload(value);
  if (!payload) {
    return [];
  }
  const tools = normalizeArray(payload.tools)
    .map((tool) => normalizeDeferredChatFunctionTool(tool))
    .filter(Boolean) as JsonRecord[];
  const namespaceTools = normalizeArray(payload.namespaces)
    .flatMap((namespace) => normalizeDeferredNamespaceChatFunctionTools(namespace));
  return dedupeDeferredChatFunctionTools([...tools, ...namespaceTools]);
}

function unwrapDeferredToolSearchPayload(value: unknown): JsonRecord | null {
  if (typeof value === 'string') {
    try {
      return unwrapDeferredToolSearchPayload(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as JsonRecord;
  if (Array.isArray(record.tools) || Array.isArray(record.namespaces)) {
    return record;
  }
  if (record.content && typeof record.content === 'object') {
    return unwrapDeferredToolSearchPayload(record.content);
  }
  return null;
}

function normalizeDeferredNamespaceChatFunctionTools(value: unknown): JsonRecord[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const namespace = value as JsonRecord;
  const namespaceName = normalizeString(namespace.name);
  return normalizeArray(namespace.tools)
    .map((tool) => normalizeDeferredChatFunctionTool(tool, namespaceName))
    .filter(Boolean) as JsonRecord[];
}

function normalizeDeferredChatFunctionTool(value: unknown, namespace = ''): JsonRecord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as JsonRecord;
  const functionRecord = record.function && typeof record.function === 'object'
    ? record.function as JsonRecord
    : record;
  const rawName = normalizeString(functionRecord.name ?? record.name);
  const name = namespace ? `${namespace}${rawName}` : rawName;
  if (!isValidDeferredChatFunctionName(name)) {
    return null;
  }
  return {
    type: 'function',
    function: omitUndefined({
      name,
      description: normalizeString(functionRecord.description ?? record.description) || undefined,
      parameters: normalizeDeferredToolParameters(functionRecord.parameters ?? record.parameters),
      strict: functionRecord.strict ?? record.strict,
    }),
  };
}

function normalizeDeferredToolParameters(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {
    type: 'object',
    properties: {},
    additionalProperties: true,
  };
}

function dedupeDeferredChatFunctionTools(tools: JsonRecord[]): JsonRecord[] {
  const seen = new Set<string>();
  const deduped: JsonRecord[] = [];
  for (const tool of tools) {
    const name = normalizeString(tool.function?.name);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    deduped.push(tool);
  }
  return deduped;
}

function isValidDeferredChatFunctionName(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

function parseChatStreamData(data: string): JsonRecord | null {
  const trimmed = normalizeString(data);
  if (!trimmed || trimmed === '[DONE]') {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as JsonRecord;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function collectStreamingToolCallDeltas(
  chunk: JsonRecord,
  accumulator: StreamingToolCallAccumulator,
): void {
  for (const choice of normalizeArray(chunk?.choices)) {
    const choiceIndex = normalizeStreamIndex(choice?.index, 0);
    for (const toolCallDelta of normalizeArray(choice?.delta?.tool_calls)) {
      accumulator.sawToolCallDelta = true;
      const toolIndex = normalizeStreamIndex(toolCallDelta?.index, 0);
      const key = `${choiceIndex}:${toolIndex}`;
      const existing = accumulator.toolCallsByKey.get(key) ?? {
        id: '',
        type: 'function',
        function: {
          name: '',
          arguments: '',
        },
      };
      const id = normalizeString(toolCallDelta?.id);
      if (id) {
        existing.id = id;
      }
      const type = normalizeString(toolCallDelta?.type);
      if (type) {
        existing.type = type;
      }
      const functionName = normalizeString(toolCallDelta?.function?.name);
      if (functionName) {
        existing.function.name += functionName;
      }
      const functionArguments = typeof toolCallDelta?.function?.arguments === 'string'
        ? toolCallDelta.function.arguments
        : '';
      if (functionArguments) {
        existing.function.arguments += functionArguments;
      }
      accumulator.toolCallsByKey.set(key, existing);
    }
  }
  for (const [key, toolCall] of accumulator.toolCallsByKey.entries()) {
    if (!normalizeString(toolCall.id)) {
      toolCall.id = `call_${key.replace(/[^A-Za-z0-9_-]/gu, '_')}`;
    }
  }
}

function chatStreamChunkHasAssistantText(chunk: JsonRecord): boolean {
  for (const choice of normalizeArray(chunk?.choices)) {
    const delta = choice?.delta;
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      return true;
    }
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      return true;
    }
    if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) {
      return true;
    }
  }
  return false;
}

function chatStreamChunkFinishedToolCalls(chunk: JsonRecord): boolean {
  return normalizeArray(chunk?.choices).some((choice) => normalizeString(choice?.finish_reason) === 'tool_calls');
}

function normalizeStreamIndex(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

async function* chainSseDataLines(
  bufferedChunks: string[],
  remaining: AsyncIterable<string>,
): AsyncGenerator<string> {
  for (const chunk of bufferedChunks) {
    yield chunk;
  }
  for await (const chunk of remaining) {
    yield chunk;
  }
}

function asyncIteratorToIterable<T>(iterator: AsyncIterator<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

async function drainAsyncIterator<T>(iterator: AsyncIterator<T>): Promise<void> {
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return;
    }
  }
}

async function* emptyAsyncIterable<T>(): AsyncGenerator<T> {}

function requestUsesExecutableRelayHostedTool(
  request: JsonRecord,
  hostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[],
): boolean {
  if (!hostedTools.some((tool) => isRelayHostedToolType(tool.name) && tool.mode === 'relay-emulated')) {
    return false;
  }
  if (normalizeArray(request?.tools).some((tool) => isExecutableRelayHostedRequestTool(tool, hostedTools))) {
    return true;
  }
  const toolChoice = request?.tool_choice;
  if (typeof toolChoice === 'string') {
    return hostedTools.some((tool) => normalizeRelayHostedToolType(toolChoice) === tool.name);
  }
  if (toolChoice && typeof toolChoice === 'object') {
    const record = toolChoice as JsonRecord;
    if (hostedTools.some((tool) => normalizeRelayHostedToolType(record.type) === tool.name)) {
      return true;
    }
    if (normalizeString(record.type) === 'allowed_tools') {
      return normalizeArray(record.tools).some((tool) => isExecutableRelayHostedRequestTool(tool, hostedTools));
    }
  }
  return false;
}

function isExecutableRelayHostedRequestTool(
  tool: unknown,
  hostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[],
): boolean {
  const normalizedType = normalizeRelayHostedToolType((tool as JsonRecord | null | undefined)?.type);
  return Boolean(normalizedType && hostedTools.some((hostedTool) => hostedTool.name === normalizedType));
}

function parseToolCallArguments(rawArguments: string): JsonRecord {
  const normalized = normalizeString(rawArguments);
  if (!normalized) {
    return {};
  }
  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { input: normalized };
  }
}

function responsesObjectToSyntheticSseEvents(response: JsonRecord): JsonRecord[] {
  const events: JsonRecord[] = [];
  const responseId = normalizeString(response?.id) || `resp_${Date.now()}`;
  let sequence = 0;
  const withSequence = (event: JsonRecord): JsonRecord => ({
    ...event,
    sequence_number: sequence += 1,
  });
  events.push(withSequence({
    type: 'response.created',
    response: {
      ...response,
      output: [],
    },
  }));
  const output = normalizeArray(response?.output);
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const item = output[outputIndex];
    const itemId = normalizeString(item?.id) || `${responseId}_item_${outputIndex}`;
    events.push(withSequence({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item,
    }));
    if (item?.type === 'message') {
      appendSyntheticMessageContentEvents(events, withSequence, item, itemId, outputIndex);
    } else if (item?.type === 'function_call') {
      const argumentsText = normalizeString(item.arguments) || '{}';
      events.push(withSequence({
        type: 'response.function_call_arguments.delta',
        item_id: itemId,
        output_index: outputIndex,
        delta: argumentsText,
      }));
      events.push(withSequence({
        type: 'response.function_call_arguments.done',
        item_id: itemId,
        output_index: outputIndex,
        arguments: argumentsText,
      }));
    } else if (item?.type === 'custom_tool_call') {
      const input = normalizeString(item.input);
      if (input) {
        events.push(withSequence({
          type: 'response.custom_tool_call_input.delta',
          item_id: itemId,
          output_index: outputIndex,
          delta: input,
        }));
      }
      events.push(withSequence({
        type: 'response.custom_tool_call_input.done',
        item_id: itemId,
        output_index: outputIndex,
        input,
      }));
    }
    events.push(withSequence({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item,
    }));
  }
  const completedType = response?.status === 'failed' ? 'response.failed' : 'response.completed';
  events.push(withSequence({
    type: completedType,
    response,
  }));
  return events;
}

function appendSyntheticMessageContentEvents(
  events: JsonRecord[],
  withSequence: (event: JsonRecord) => JsonRecord,
  item: JsonRecord,
  itemId: string,
  outputIndex: number,
): void {
  const content = normalizeArray(item.content);
  for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
    const part = content[contentIndex];
    events.push(withSequence({
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part,
    }));
    const text = normalizeString(part?.text);
    if (text && normalizeString(part?.type) === 'output_text') {
      events.push(withSequence({
        type: 'response.output_text.delta',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        delta: text,
      }));
      events.push(withSequence({
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        text,
      }));
    }
    events.push(withSequence({
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part,
    }));
  }
}

function formatResponsesSseEvent(event: JsonRecord): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function ensureSseResponseHeaders(response: ServerResponse): void {
  if (response.headersSent) {
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function buildHostedToolSseEvent({
  type,
  entry,
  relayToolName,
  callId,
  iteration,
  startedAt,
  argumentsObject,
  delta,
  durationMs,
  metadata,
  outputPreview,
  error,
}: {
  type: 'hosted_tool.started' | 'hosted_tool.delta' | 'hosted_tool.completed' | 'hosted_tool.failed';
  entry: RelayHostedToolCall;
  relayToolName: string;
  callId: string;
  iteration: number;
  startedAt: number;
  argumentsObject?: JsonRecord | null;
  delta?: unknown;
  durationMs?: number | null;
  metadata?: JsonRecord | null;
  outputPreview?: string | null;
  error?: JsonRecord | null;
}): JsonRecord {
  return omitUndefined({
    type,
    hosted_tool: omitUndefined({
      name: entry.declaration.name,
      relay_tool_name: relayToolName,
      call_id: callId,
      iteration,
      started_at: new Date(startedAt).toISOString(),
      duration_ms: durationMs ?? undefined,
      arguments: argumentsObject ?? undefined,
      delta: delta ?? undefined,
      metadata: metadata ?? undefined,
      output_preview: outputPreview ?? undefined,
      error: error ?? undefined,
    }),
  });
}

function hostedToolOutputPreview(content: string): string {
  const normalized = normalizeString(content);
  if (normalized.length <= 500) {
    return normalized;
  }
  return `${normalized.slice(0, 500)}...`;
}

function appendHostedToolResultsToResponsesOutput({
  response,
  request,
  executions,
  exposeByDefault,
}: {
  response: JsonRecord;
  request: JsonRecord;
  executions: RelayHostedToolExecutionRecord[];
  exposeByDefault: boolean;
}): void {
  if (executions.length === 0) {
    return;
  }
  const output = Array.isArray(response.output) ? response.output : [];
  for (const execution of executions) {
    if (
      execution.toolName === 'file_search'
      && shouldExposeFileSearchResults(request, exposeByDefault)
    ) {
      const results = extractFileSearchResultsFromHostedToolOutput(execution.content);
      if (results.length === 0) {
        continue;
      }
      output.push({
        id: `fs_${execution.callId}`,
        type: 'file_search_call',
        status: 'completed',
        call_id: execution.callId,
        queries: normalizeString(execution.arguments.query)
          ? [normalizeString(execution.arguments.query)]
          : [],
        results,
      });
    } else if (
      execution.toolName === 'image_generation'
      && shouldExposeImageGenerationResults(request, exposeByDefault)
    ) {
      const images = extractImageGenerationResultsFromHostedToolOutput(execution.content);
      if (images.length === 0) {
        continue;
      }
      output.push({
        id: `ig_${execution.callId}`,
        type: 'image_generation_call',
        status: 'completed',
        call_id: execution.callId,
        prompt: normalizeString(execution.arguments.prompt)
          || normalizeString(execution.arguments.input)
          || null,
        result: images,
      });
    }
  }
  response.output = output;
}

function shouldExposeFileSearchResults(request: JsonRecord, exposeByDefault: boolean): boolean {
  if (exposeByDefault) {
    return true;
  }
  return normalizeArray(request?.include).some((entry) => normalizeString(entry) === 'file_search_call.results');
}

function shouldExposeImageGenerationResults(request: JsonRecord, exposeByDefault: boolean): boolean {
  if (exposeByDefault) {
    return true;
  }
  return normalizeArray(request?.include).some((entry) => {
    const normalized = normalizeString(entry);
    return normalized === 'image_generation_call.results'
      || normalized === 'image_generation_call.result';
  });
}

function extractFileSearchResultsFromHostedToolOutput(content: string): JsonRecord[] {
  const parsed = parseJsonObject(content);
  const payload = parsed?.content && typeof parsed.content === 'object'
    ? parsed.content as JsonRecord
    : parsed;
  if (!payload) {
    return [];
  }
  const results = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.search_results)
      ? payload.search_results
      : [];
  return results
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => normalizeFileSearchCallResult(entry as JsonRecord));
}

function normalizeFileSearchCallResult(result: JsonRecord): JsonRecord {
  return omitUndefined({
    file_id: normalizeString(result.file_id) || null,
    filename: normalizeString(result.filename) || null,
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : null,
    attributes: result.attributes && typeof result.attributes === 'object'
      ? result.attributes
      : {},
    content: Array.isArray(result.content)
      ? result.content.filter((entry) => entry && typeof entry === 'object')
      : [],
  });
}

function extractImageGenerationResultsFromHostedToolOutput(content: string): JsonRecord[] {
  const parsed = parseJsonObject(content);
  const payload = parsed?.content && typeof parsed.content === 'object'
    ? parsed.content as JsonRecord
    : parsed;
  if (!payload) {
    return [];
  }
  return normalizeArray(payload.images)
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => normalizeImageGenerationCallResult(entry as JsonRecord))
    .filter((entry) => entry.b64_json || entry.url);
}

function normalizeImageGenerationCallResult(result: JsonRecord): JsonRecord {
  return omitUndefined({
    b64_json: normalizeString(result.b64_json) || null,
    url: normalizeString(result.url) || null,
    mime_type: normalizeString(result.mime_type) || null,
    revised_prompt: normalizeString(result.revised_prompt) || null,
  });
}

function parseJsonObject(value: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

async function* readSseDataLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let splitIndex = findSseFrameBoundary(buffer);
      while (splitIndex >= 0) {
        const frame = buffer.slice(0, splitIndex);
        buffer = buffer.slice(buffer[splitIndex] === '\r' ? splitIndex + 4 : splitIndex + 2);
        const data = extractSseData(frame);
        if (data !== null) {
          yield data;
        }
        splitIndex = findSseFrameBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    const data = extractSseData(buffer);
    if (data !== null) {
      yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function findSseFrameBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0) {
    return crlf;
  }
  if (crlf < 0) {
    return lf;
  }
  return Math.min(lf, crlf);
}

function extractSseData(frame: string): string | null {
  const lines = frame.split(/\r?\n/u);
  const eventName = lines
    .find((line) => line.startsWith('event:'))
    ?.slice(6)
    .trim();
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) {
    return null;
  }
  const data = dataLines.join('\n');
  if (eventName === 'error' && data.trim() !== '[DONE]') {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({
          type: 'error',
          ...parsed,
        });
      }
    } catch {
      // Fall through to a normalized top-level error payload below.
    }
    return JSON.stringify({
      type: 'error',
      message: data,
    });
  }
  return data;
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

export function buildOpenAICompatibleChatCompletionsUrl(
  baseUrl: string,
  pathname = '/chat/completions',
): string {
  const normalizedPath = normalizePath(pathname) || '/chat/completions';
  return buildOpenAICompatibleEndpointUrl(baseUrl, normalizedPath);
}

export function buildOpenAICompatibleModelsUrl(baseUrl: string): string {
  const base = stripChatCompletionsSuffix(normalizeEndpointBaseUrl(baseUrl));
  return buildOpenAICompatibleEndpointUrl(base, '/models');
}

function buildChatCompletionsUrl(baseUrl: string, pathname: string): string {
  return buildOpenAICompatibleChatCompletionsUrl(baseUrl, pathname);
}

function buildOpenAICompatibleEndpointUrl(baseUrl: string, endpointPath: string): string {
  const endpoint = normalizePath(endpointPath) || '/chat/completions';
  const skipVersionPrefix = normalizeString(baseUrl).endsWith('#');
  const base = endpoint === '/models'
    ? stripChatCompletionsSuffix(normalizeEndpointBaseUrl(baseUrl))
    : normalizeEndpointBaseUrl(baseUrl);
  if (base.toLowerCase().endsWith(endpoint.toLowerCase())) {
    return base;
  }
  const originOnly = isOriginOnlyBaseUrl(base);
  let url = skipVersionPrefix || hasVersionSuffix(base) || !originOnly
    ? `${base}${endpoint}`
    : `${base}/v1${endpoint}`;
  while (url.includes('/v1/v1')) {
    url = url.replace('/v1/v1', '/v1');
  }
  return url;
}

function normalizeEndpointBaseUrl(baseUrl: string): string {
  return normalizeString(baseUrl)
    .replace(/#+$/u, '')
    .replace(/\/+$/u, '');
}

function stripChatCompletionsSuffix(baseUrl: string): string {
  return baseUrl.toLowerCase().endsWith('/chat/completions')
    ? baseUrl.slice(0, -'/chat/completions'.length)
    : baseUrl;
}

function isOriginOnlyBaseUrl(baseUrl: string): boolean {
  const parts = baseUrl.split('://', 2);
  return parts.length === 2
    ? !parts[1].includes('/')
    : !baseUrl.includes('/');
}

function hasVersionSuffix(baseUrl: string): boolean {
  return /\/v\d+(?:beta)?$/iu.test(baseUrl);
}

function isResponsesPath(pathname: string): boolean {
  const canonical = canonicalProxyRoutePath(pathname);
  return canonical === '/responses' || isResponsesCompactPath(pathname);
}

function isResponsesCompactPath(pathname: string): boolean {
  return canonicalProxyRoutePath(pathname) === '/responses/compact';
}

function isModelsPath(pathname: string): boolean {
  return isOpenAICompatibleModelsProxyPath(pathname);
}

export function isOpenAICompatibleResponsesProxyPath(pathname: string): boolean {
  return isResponsesPath(pathname);
}

export function isOpenAICompatibleChatCompletionsProxyPath(pathname: string): boolean {
  return canonicalProxyRoutePath(pathname) === '/chat/completions';
}

export function isOpenAICompatibleModelsProxyPath(pathname: string): boolean {
  return canonicalProxyRoutePath(pathname) === '/models';
}

function canonicalProxyRoutePath(pathname: string): string {
  const [pathOnly] = normalizeString(pathname).split('?', 1);
  let path = normalizePath(pathOnly) || '/';
  while (path.startsWith('/v1/v1/')) {
    path = `/v1${path.slice('/v1/v1'.length)}`;
  }
  if (path === '/codex/v1') {
    return '/';
  }
  if (path.startsWith('/codex/v1/')) {
    path = path.slice('/codex/v1'.length);
  }
  if (path.startsWith('/v1/')) {
    path = path.slice('/v1'.length);
  }
  return path;
}

function normalizeModels(
  models: OpenAICompatibleResponsesAdapterServerOptions['models'],
  defaultModel: string,
  ownedBy: string,
  providerKind: string,
  providerCapabilities: OpenAICompatibleProviderCapabilities | null,
) {
  const now = Math.floor(Date.now() / 1000);
  const entries = (Array.isArray(models) ? models : [])
    .map((model) => {
      const id = normalizeString(model?.id) || normalizeString(model?.model);
      if (!id) {
        return null;
      }
      return {
        ...model,
        id,
        slug: normalizeString(model?.slug) || id,
        object: normalizeString(model?.object) || 'model',
        created: Number.isFinite(Number(model?.created)) ? Number(model.created) : now,
        owned_by: normalizeString(model?.owned_by) || ownedBy,
        displayName: normalizeString(model?.displayName) || normalizeString(model?.display_name) || id,
        display_name: normalizeString(model?.display_name) || normalizeString(model?.displayName) || id,
        capabilityCatalog: model?.capabilityCatalog && typeof model.capabilityCatalog === 'object'
          ? model.capabilityCatalog
          : buildOpenAICompatibleCapabilityCatalogMetadata({
            modelId: id,
            providerKind,
            providerCapabilities,
            modelCapabilities: model?.capabilities && typeof model.capabilities === 'object'
              ? model.capabilities as OpenAICompatibleModelCapabilities
              : null,
          }),
        protocol: buildProtocolMetadataForModel({
          modelId: id,
          modelEntry: model,
          providerKind,
          providerCapabilities,
        }),
      };
    })
    .filter(Boolean);
  if (entries.length > 0) {
    const seen = new Set<string>();
    return entries.filter((entry) => {
      if (!entry || seen.has(entry.id)) {
        return false;
      }
      seen.add(entry.id);
      return true;
    });
  }
  return [{
    id: defaultModel,
    slug: defaultModel,
    object: 'model',
    created: now,
    owned_by: ownedBy,
    capabilityCatalog: buildOpenAICompatibleCapabilityCatalogMetadata({
      modelId: defaultModel,
      providerKind,
      providerCapabilities,
      modelCapabilities: null,
    }),
    protocol: buildProtocolMetadataForModel({
      modelId: defaultModel,
      modelEntry: null,
      providerKind,
      providerCapabilities,
    }),
  }];
}

function buildProtocolMetadataForModel({
  modelId,
  modelEntry,
  providerKind,
  providerCapabilities,
}: {
  modelId: string;
  modelEntry: Record<string, any> | null | undefined;
  providerKind: string;
  providerCapabilities: OpenAICompatibleProviderCapabilities | null;
}): JsonRecord {
  const modelCapabilities = modelEntry?.capabilities && typeof modelEntry.capabilities === 'object'
    ? modelEntry.capabilities as OpenAICompatibleModelCapabilities
    : null;
  const effectiveCapabilities = resolveOpenAICompatibleProviderCapabilitiesForModel(
    modelCapabilities
      ? {
        ...(providerCapabilities ?? {}),
        modelCapabilities: {
          ...(providerCapabilities?.modelCapabilities ?? {}),
          [modelId]: modelCapabilities,
        },
      }
      : providerCapabilities,
    modelId,
  );
  const reasoning = getProviderThinkingSupport(providerKind, effectiveCapabilities);
  const thinkingPolicy = getOpenAICompatibleThinkingPolicy(providerKind, effectiveCapabilities);
  const multimodal = effectiveCapabilities?.multimodal ?? null;
  const payloadCompatibility = inspectOpenAICompatiblePayloadCompatibility({
    model: modelId,
    protocol: providerKind,
    providerCapabilities: effectiveCapabilities,
  });

  return {
    tools: {
      supported: effectiveCapabilities?.supportsTools !== false,
      builtinWebSearch: effectiveCapabilities?.supportsBuiltinWebSearchTool !== false,
      parallelToolCalls: typeof modelCapabilities?.parallelToolCalls === 'boolean'
        ? modelCapabilities.parallelToolCalls
        : !payloadBlocksPath(effectiveCapabilities?.payload, 'parallel_tool_calls'),
    },
    multimodal: {
      imageInput: normalizeNullableBoolean(multimodal?.supportsImageInput),
      imageUrlInput: normalizeNullableBoolean(multimodal?.supportsImageUrlInput),
      imageBase64Input: normalizeNullableBoolean(multimodal?.supportsImageBase64Input),
      fileInput: normalizeNullableBoolean(multimodal?.supportsFileInput),
      pdfInput: normalizeNullableBoolean(multimodal?.supportsPdfInput)
        ?? (normalizeNullableBoolean(multimodal?.supportsFileInput) === false ? false : null),
      fileDataInput: normalizeNullableBoolean(multimodal?.supportsFileDataInput),
      fileIdInput: normalizeNullableBoolean(multimodal?.supportsFileIdInput),
      fileUrlInput: normalizeNullableBoolean(multimodal?.supportsFileUrlInput),
      unsupportedInputPartStrategy: normalizeString(multimodal?.unsupportedInputPartStrategy) || null,
    },
    reasoning: {
      supported: reasoning.supportedReasoningEfforts.length > 0,
      supportedReasoningEfforts: reasoning.supportedReasoningEfforts,
      defaultReasoningEffort: reasoning.defaultReasoningEffort,
      transport: {
        mode: thinkingPolicy.mode,
        booleanField: normalizeString(thinkingPolicy.booleanField) || null,
        strippedFields: [...thinkingPolicy.stripFields],
      },
    },
    retry: buildNormalizedRetryMetadata(effectiveCapabilities?.retry),
    structuredOutput: {
      jsonSchema: typeof modelCapabilities?.jsonSchema === 'boolean'
        ? modelCapabilities.jsonSchema
        : !payloadBlocksPath(effectiveCapabilities?.payload, 'response_format'),
    },
    responses: {
      supportsCompact: effectiveCapabilities?.supportsResponsesCompact === true,
    },
    routing: {
      upstreamModel: payloadCompatibility.upstreamModel,
      requiresModelAlias: payloadCompatibility.upstreamModel !== modelId,
    },
    limits: {
      maxOutputTokens: normalizePositiveNumber(modelCapabilities?.maxOutputTokens),
    },
  };
}

function buildModelsResponseMetadata({
  defaultModel,
  ownedBy,
  providerKind,
  providerName,
  providerCapabilities,
  upstreamChatCompletionsPath,
}: {
  defaultModel: string;
  ownedBy: string;
  providerKind: string;
  providerName: string;
  providerCapabilities: OpenAICompatibleProviderCapabilities | null;
  upstreamChatCompletionsPath: string;
}): JsonRecord {
  return {
    provider: {
      kind: providerKind,
      name: providerName,
      ownedBy,
    },
    defaults: {
      model: defaultModel,
    },
    retry: buildNormalizedRetryMetadata(providerCapabilities?.retry),
    routes: {
      primary: {
        models: '/models',
        responses: '/responses',
        responsesCompact: '/responses/compact',
      },
      compatibility: {
        models: '/v1/models',
        responses: '/v1/responses',
        responsesCompact: '/v1/responses/compact',
      },
      upstream: {
        chatCompletions: upstreamChatCompletionsPath,
        responsesCompact: providerCapabilities?.supportsResponsesCompact === true
          ? normalizePath(providerCapabilities.upstreamResponsesCompactPath) || '/responses/compact'
          : null,
      },
    },
  };
}

function payloadBlocksPath(
  payload: OpenAICompatibleProviderCapabilities['payload'] | null | undefined,
  path: string,
): boolean {
  const normalizedPath = normalizeString(path);
  if (!normalizedPath) {
    return false;
  }
  return Boolean(payload?.filter?.some((rule) => (
    Array.isArray(rule?.paths)
    && rule.paths.some((entry) => normalizeString(entry) === normalizedPath)
  )));
}

function summarizeRequestAdjustments({
  request,
  upstreamRequest,
  providerCapabilities,
  hostedTools = [],
}: {
  request: JsonRecord;
  upstreamRequest: JsonRecord;
  providerCapabilities: OpenAICompatibleProviderCapabilities | null;
  hostedTools?: NormalizedCodexProviderRelayHostedToolDeclaration[];
}): CodexProviderRelayRequestAdjustment[] {
  const adjustments: CodexProviderRelayRequestAdjustment[] = [];
  const requestedModel = normalizeString(request?.model);
  const upstreamModel = normalizeString(upstreamRequest?.model);
  if (requestedModel && upstreamModel && requestedModel !== upstreamModel) {
    adjustments.push({
      kind: 'model_overridden',
      path: 'model',
      reason: 'payload_override',
      before: requestedModel,
      after: upstreamModel,
    });
  }

  const requestedMaxOutputTokens = normalizePositiveNumber(request?.max_output_tokens);
  const upstreamMaxTokens = normalizePositiveNumber(upstreamRequest?.max_tokens);
  if (
    requestedMaxOutputTokens !== null
    && upstreamMaxTokens !== null
    && upstreamMaxTokens < requestedMaxOutputTokens
  ) {
    adjustments.push({
      kind: 'max_output_tokens_capped',
      path: 'max_output_tokens',
      reason: 'model_limit',
      before: requestedMaxOutputTokens,
      after: upstreamMaxTokens,
    });
  }

  if (request?.parallel_tool_calls !== undefined && upstreamRequest?.parallel_tool_calls === undefined) {
    adjustments.push({
      kind: 'field_filtered',
      path: 'parallel_tool_calls',
      reason: 'payload_filter',
      before: request.parallel_tool_calls,
    });
  }

  if (request?.text?.format !== undefined && upstreamRequest?.response_format === undefined) {
    adjustments.push({
      kind: 'field_filtered',
      path: 'text.format',
      reason: 'payload_filter_or_unsupported_format',
      before: request.text.format,
    });
  }

  const requestedTools = normalizeArray(request?.tools);
  if (requestedTools.length > 0) {
    const requestedFunctionTools = requestedTools.filter((tool) => normalizeString(tool?.type) === 'function').length;
    const requestedBuiltinTools = requestedTools.filter((tool) => isBuiltinWebSearchToolType(tool?.type)).length;
    const upstreamTools = normalizeArray(upstreamRequest?.tools);
    const forwardedFunctionTools = upstreamTools.filter((tool) => normalizeString(tool?.type) === 'function').length;
    const forwardedBuiltinTools = upstreamTools.filter((tool) => isBuiltinWebSearchToolType(tool?.type)).length;
    const forwardedRelayHostedBuiltinTools = upstreamTools
      .filter((tool) => isRelayHostedBuiltinChatTool(tool, hostedTools))
      .length;

    if (requestedFunctionTools > forwardedFunctionTools) {
      adjustments.push({
        kind: 'tools_dropped',
        path: 'tools',
        reason: providerCapabilities?.supportsTools === false
          ? 'tool_calling_disabled'
          : 'unsupported_or_invalid_tools',
        requestedCount: requestedFunctionTools,
        forwardedCount: forwardedFunctionTools,
      });
    }
    if (requestedBuiltinTools > forwardedBuiltinTools + forwardedRelayHostedBuiltinTools) {
      adjustments.push({
        kind: 'tools_dropped',
        path: 'tools',
        reason: providerCapabilities?.supportsBuiltinWebSearchTool === false
          ? 'builtin_web_search_unsupported'
          : 'unsupported_or_invalid_tools',
        requestedCount: requestedBuiltinTools,
        forwardedCount: forwardedBuiltinTools + forwardedRelayHostedBuiltinTools,
      });
    }
  }

  if (request?.tool_choice !== undefined && upstreamRequest?.tool_choice === undefined) {
    adjustments.push({
      kind: 'tool_choice_dropped',
      path: 'tool_choice',
      reason: 'unsupported_or_filtered',
      before: request.tool_choice,
    });
  }

  const requestedParts = countRequestedInputParts(request?.input);
  const forwardedParts = countForwardedInputParts(upstreamRequest?.messages);
  const strategy = normalizeString(providerCapabilities?.multimodal?.unsupportedInputPartStrategy) || null;
  if (requestedParts.image > forwardedParts.image) {
    adjustments.push({
      kind: 'image_input_downgraded',
      path: 'input.image',
      reason: 'unsupported_input_part_strategy',
      requestedCount: requestedParts.image,
      forwardedCount: forwardedParts.image,
      strategy,
    });
  }
  if (requestedParts.file > forwardedParts.file) {
    adjustments.push({
      kind: 'file_input_downgraded',
      path: 'input.file',
      reason: 'unsupported_input_part_strategy',
      requestedCount: requestedParts.file,
      forwardedCount: forwardedParts.file,
      strategy,
    });
  }

  return adjustments;
}

function countRequestedInputParts(input: unknown): { image: number; file: number } {
  const counts = { image: 0, file: 0 };
  for (const item of normalizeArray(input)) {
    const contents = typeof item?.content === 'string' ? [] : normalizeArray(item?.content);
    for (const part of contents) {
      const type = normalizeString(part?.type);
      if (type === 'input_image' || type === 'image') {
        counts.image += 1;
      } else if (type === 'input_file' || type === 'file') {
        counts.file += 1;
      }
    }
  }
  return counts;
}

function countForwardedInputParts(messages: unknown): { image: number; file: number } {
  const counts = { image: 0, file: 0 };
  for (const message of normalizeArray(messages)) {
    if (typeof message?.content === 'string') {
      continue;
    }
    for (const part of normalizeArray(message?.content)) {
      const type = normalizeString(part?.type);
      if (type === 'image_url') {
        counts.image += 1;
      } else if (type === 'file') {
        counts.file += 1;
      }
    }
  }
  return counts;
}

function resolveModelMetadata(
  models: Array<Record<string, any> & { id?: string; slug?: string; model?: string }>,
  modelId: string,
): JsonRecord | null {
  const normalizedModelId = normalizeString(modelId);
  if (!normalizedModelId) {
    return null;
  }
  return models.find((model) => (
    normalizeString(model?.id) === normalizedModelId
    || normalizeString(model?.slug) === normalizedModelId
    || normalizeString(model?.model) === normalizedModelId
  )) ?? null;
}

function extractUpstreamError(text: string): string | null {
  const trimmed = normalizeString(text);
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return normalizeString(parsed?.error?.message)
      || normalizeString(parsed?.message)
      || trimmed;
  } catch {
    return trimmed;
  }
}

function normalizeUpstreamError(
  text: string,
  providerName: string,
  status: number,
  headers?: Headers | null,
): JsonRecord {
  const trimmed = normalizeString(text);
  const retryAfterMs = parseRetryAfterMs(headers?.get('retry-after') ?? null) ?? parseRetryAfterMsFromBody(trimmed);
  const metadata = buildUpstreamErrorMetadata(headers);
  const fallbackCode = upstreamErrorCode(status);
  const fallbackCategory = classifyGatewayErrorCategory({
    status,
    code: fallbackCode,
    type: 'upstream_error',
    message: trimmed,
  });
  const fallbackRetry = buildGatewayRetryMetadata(fallbackCategory, retryAfterMs);
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed?.error && typeof parsed.error === 'object') {
        const message = normalizeString(parsed.error.message) || `${providerName} upstream returned HTTP ${status}`;
        const type = normalizeString(parsed.error.type) || 'upstream_error';
        const code = parsed.error.code ?? fallbackCode;
        const category = classifyGatewayErrorCategory({
          status,
          code,
          type,
          message,
        });
        return omitUndefined({
          message,
          type,
          code,
          category,
          retry: buildGatewayRetryMetadata(category, retryAfterMs),
          param: parsed.error.param,
          retry_after_ms: retryAfterMs,
          metadata,
        });
      }
      const message = normalizeString(parsed?.message) || trimmed;
      const type = normalizeString(parsed?.type) || 'upstream_error';
      const code = parsed?.code ?? fallbackCode;
      const category = classifyGatewayErrorCategory({
        status,
        code,
        type,
        message,
      });
      return omitUndefined({
        message,
        type,
        code,
        category,
        retry: buildGatewayRetryMetadata(category, retryAfterMs),
        retry_after_ms: retryAfterMs,
        metadata,
      });
    } catch {
      return omitUndefined({
        message: trimmed,
        type: 'upstream_error',
        code: fallbackCode,
        category: fallbackCategory,
        retry: fallbackRetry,
        retry_after_ms: retryAfterMs,
        metadata,
      });
    }
  }
  return omitUndefined({
    message: `${providerName} upstream returned HTTP ${status}`,
    type: 'upstream_error',
    code: fallbackCode,
    category: fallbackCategory,
    retry: fallbackRetry,
    retry_after_ms: retryAfterMs,
    metadata,
  });
}

function buildMalformedUpstreamPayloadError(
  providerName: string,
  detail: string,
): JsonRecord {
  const message = normalizeString(detail)
    ? `${providerName} upstream returned a malformed success payload: ${normalizeString(detail)}`
    : `${providerName} upstream returned a malformed success payload.`;
  return {
    message,
    type: 'upstream_error',
    code: 'malformed_upstream_payload',
    category: 'malformed_upstream',
    retry: buildGatewayRetryMetadata('malformed_upstream', null),
  };
}

function buildUpstreamErrorMetadata(headers?: Headers | null): JsonRecord | undefined {
  if (!headers) {
    return undefined;
  }
  const requestId = normalizeString(headers.get('x-request-id') ?? headers.get('request-id'));
  const region = normalizeString(headers.get('x-ms-region') ?? headers.get('openai-processing-ms'));
  const rateLimitHeaders = collectRateLimitHeaders(headers);
  if (!requestId && !region && !rateLimitHeaders) {
    return undefined;
  }
  return omitUndefined({
    request_id: requestId || undefined,
    region: region || undefined,
    rate_limit_headers: rateLimitHeaders ?? undefined,
  });
}

function collectRateLimitHeaders(headers: Headers): JsonRecord | undefined {
  const values: JsonRecord = {};
  for (const [key, value] of headers.entries()) {
    const normalizedKey = key.toLowerCase();
    if (!normalizedKey.startsWith('x-ratelimit-') && !normalizedKey.startsWith('ratelimit-')) {
      continue;
    }
    const normalizedValue = normalizeString(value);
    if (!normalizedValue) {
      continue;
    }
    values[normalizedKey] = normalizedValue;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

function normalizeRetryCapabilities(capabilities: OpenAICompatibleRetryCapabilities | null | undefined): {
  maxAttempts: number;
  retryStatuses: Set<number>;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMaxMs: number;
  retryNetworkErrors: boolean;
} {
  if (!capabilities || typeof capabilities !== 'object') {
    return {
      maxAttempts: 1,
      retryStatuses: new Set(DEFAULT_RETRY_STATUSES),
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryAfterMaxMs: 0,
      retryNetworkErrors: false,
    };
  }
  const maxAttempts = clampInteger(capabilities.maxAttempts, 1, 5, 1);
  return {
    maxAttempts,
    retryStatuses: new Set(normalizeRetryStatuses(capabilities.retryStatuses) ?? DEFAULT_RETRY_STATUSES),
    baseDelayMs: clampInteger(capabilities.baseDelayMs, 0, 30_000, 250),
    maxDelayMs: clampInteger(capabilities.maxDelayMs, 0, 60_000, 2_000),
    retryAfterMaxMs: clampInteger(capabilities.retryAfterMaxMs, 0, 300_000, 30_000),
    retryNetworkErrors: Boolean(capabilities.retryNetworkErrors),
  };
}

function buildNormalizedRetryMetadata(
  capabilities: OpenAICompatibleRetryCapabilities | null | undefined,
): JsonRecord {
  const normalized = normalizeRetryCapabilities(capabilities);
  const enabled = normalized.maxAttempts > 1;
  return {
    enabled,
    maxAttempts: normalized.maxAttempts,
    retryStatuses: enabled ? [...normalized.retryStatuses].sort((left, right) => left - right) : [],
    baseDelayMs: enabled ? normalized.baseDelayMs : 0,
    maxDelayMs: enabled ? normalized.maxDelayMs : 0,
    retryAfterMaxMs: enabled ? normalized.retryAfterMaxMs : 0,
    retryNetworkErrors: enabled ? normalized.retryNetworkErrors : false,
  };
}

function normalizeRetryStatuses(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const statuses = value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry >= 100 && entry <= 599);
  return statuses.length > 0 ? [...new Set(statuses)] : null;
}

function shouldRetryWithoutForcedToolChoice(
  chatBody: JsonRecord,
  upstream: {
    response: Response;
    errorText: string | null;
  },
): boolean {
  if (upstream.response.ok || upstream.response.status < 400 || upstream.response.status >= 500) {
    return false;
  }
  if (!isForcedChatToolChoice(chatBody?.tool_choice) || normalizeArray(chatBody?.tools).length === 0) {
    return false;
  }
  const errorText = normalizeString(upstream.errorText).toLowerCase();
  if (!errorText.includes('tool_choice')) {
    return false;
  }
  return errorText.includes('not support')
    || errorText.includes('does not support')
    || errorText.includes('unsupported')
    || errorText.includes('invalidparameter')
    || errorText.includes('invalid parameter');
}

function isForcedChatToolChoice(value: unknown): boolean {
  if (value && typeof value === 'object') {
    return true;
  }
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized || normalized === 'auto' || normalized === 'none') {
    return false;
  }
  return true;
}

function resolveRetryDelayMs(
  headers: Headers | null,
  text: string,
  attempt: number,
  retry: ReturnType<typeof normalizeRetryCapabilities>,
): number {
  const retryAfter = parseRetryAfterMs(headers?.get('retry-after') ?? null)
    ?? parseRetryAfterMsFromBody(text);
  if (retryAfter !== null) {
    return retry.retryAfterMaxMs > 0 ? Math.min(retryAfter, retry.retryAfterMaxMs) : retryAfter;
  }
  if (retry.baseDelayMs <= 0 || retry.maxDelayMs <= 0) {
    return 0;
  }
  return Math.min(retry.maxDelayMs, retry.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

function parseRetryAfterMs(value: string | null): number | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const seconds = Number(normalized);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(normalized);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }
  return null;
}

function parseRetryAfterMsFromBody(text: string): number | null {
  const trimmed = normalizeString(text);
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parseRetryAfterMs(
      parsed?.retry_after
        ?? parsed?.retryAfter
        ?? parsed?.error?.retry_after
        ?? parsed?.error?.retryAfter
        ?? null,
    );
  } catch {
    return null;
  }
}

async function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function upstreamErrorCode(status: number): string {
  switch (status) {
    case 401:
      return 'invalid_api_key';
    case 403:
      return 'insufficient_quota';
    case 404:
      return 'model_not_found';
    case 408:
      return 'request_timeout';
    case 429:
      return 'rate_limit_exceeded';
    default:
      if (status >= 500) {
        return 'internal_server_error';
      }
      if (status >= 400) {
        return 'invalid_request_error';
      }
      return 'unknown_error';
  }
}

function classifyGatewayErrorCategory({
  status,
  code,
  type,
  message,
}: {
  status: number;
  code: unknown;
  type: unknown;
  message: unknown;
}): GatewayErrorCategory {
  const normalizedCode = normalizeString(code).toLowerCase();
  const normalizedType = normalizeString(type).toLowerCase();
  const normalizedMessage = normalizeString(message).toLowerCase();
  if (
    status === 401
    || normalizedCode.includes('invalid_api_key')
    || normalizedCode.includes('authentication')
    || normalizedType.includes('authentication')
    || normalizedMessage.includes('invalid api key')
    || normalizedMessage.includes('unauthorized')
  ) {
    return 'authentication';
  }
  if (
    status === 429
    || normalizedCode.includes('rate_limit')
    || normalizedType.includes('rate_limit')
    || normalizedMessage.includes('rate limit')
    || normalizedMessage.includes('too many requests')
  ) {
    return 'rate_limit';
  }
  if (
    normalizedCode.includes('unsupported')
    || normalizedType.includes('unsupported')
    || normalizedMessage.includes('not support')
    || normalizedMessage.includes('unsupported')
    || normalizedMessage.includes('does not support')
  ) {
    return 'unsupported_feature';
  }
  if (status === 404 || normalizedCode.includes('not_found') || normalizedMessage.includes('not found')) {
    return 'not_found';
  }
  if (status === 408 || status >= 500) {
    return 'transient_upstream';
  }
  if (status >= 400 && status < 500) {
    return 'invalid_request';
  }
  return 'upstream_failure';
}

function buildGatewayRetryMetadata(
  category: GatewayErrorCategory,
  retryAfterMs: number | null,
): { retryable: boolean; hint: GatewayRetryHint; retry_after_ms?: number } {
  switch (category) {
    case 'authentication':
      return omitUndefined({
        retryable: false,
        hint: 'check_api_key_or_access',
      });
    case 'rate_limit':
      return omitUndefined({
        retryable: true,
        hint: 'respect_retry_after',
        retry_after_ms: retryAfterMs ?? undefined,
      });
    case 'transient_upstream':
      return omitUndefined({
        retryable: true,
        hint: 'retry_with_backoff',
        retry_after_ms: retryAfterMs ?? undefined,
      });
    case 'unsupported_feature':
      return {
        retryable: false,
        hint: 'remove_or_downgrade_unsupported_feature',
      };
    case 'not_found':
      return {
        retryable: false,
        hint: 'check_model_or_route',
      };
    case 'invalid_request':
      return {
        retryable: false,
        hint: 'fix_request',
      };
    case 'malformed_upstream':
    case 'upstream_failure':
    default:
      return omitUndefined({
        retryable: true,
        hint: 'retry_or_inspect_upstream',
        retry_after_ms: retryAfterMs ?? undefined,
      });
  }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function normalizeArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function isBuiltinWebSearchToolType(type: unknown): boolean {
  return normalizeCodexProviderRelayBuiltinToolName(type) === 'web_search';
}

function isRelayHostedToolType(type: unknown): boolean {
  return isCodexProviderRelayRelayEmulatedBuiltinToolType(type);
}

function normalizeRelayHostedToolType(type: unknown): string {
  return normalizeCodexProviderRelayBuiltinToolName(type) ?? normalizeString(type);
}

function isRelayHostedBuiltinChatTool(
  tool: unknown,
  hostedTools: NormalizedCodexProviderRelayHostedToolDeclaration[],
): boolean {
  if (!tool || typeof tool !== 'object') {
    return false;
  }
  const record = tool as JsonRecord;
  if (normalizeString(record.type) !== 'function') {
    return false;
  }
  const functionName = normalizeString(record.function?.name);
  return Boolean(functionName && hostedTools.some((hostedTool) => (
    isRelayHostedToolType(hostedTool.name)
    && hostedTool.mode === 'relay-emulated'
    && normalizeString(hostedTool.relayToolName || hostedTool.name) === functionName
  )));
}

function normalizePath(value: unknown): string {
  const normalized = normalizeString(value);
  if (!normalized) {
    return '';
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function omitUndefined<T extends JsonRecord>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function reserveLocalPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
