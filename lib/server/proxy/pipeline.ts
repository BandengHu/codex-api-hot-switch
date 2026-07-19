import "server-only"

import { appendLog, getRoutingSnapshot } from "@/lib/server/state-store"
import {
  appendRequestLogDetails,
  registerRequestLogDetailSource,
} from "@/lib/server/request-log-details"
import {
  buildCodexClientModelsResponse,
  buildOpenAIModelsResponse,
} from "@/lib/server/codex-model-catalog"
import type { RequestLog, TokenUsage, WebSearchMode } from "@/lib/types"
import {
  applyAssistantMessagePhase,
  compactJson,
  isOpenAIChatProtocol,
  isOpenAIResponsesProtocol,
  isResponsesCompactPath,
  isResponsesPath,
  responseId,
  resolveTarget,
  type ProxyTarget,
} from "./common"
import { filterPrivateParams } from "./body-filter"
import {
  applyImageGenerationModel,
  containsImageGenerationTool,
  resolveImageGenerationTarget,
} from "./image-generation-tools"
import {
  appendLanguagePolicyDiagnostic,
  registerLanguagePolicyDiagnosticSource,
} from "./language-policy-diagnostics"
import { shouldApplyOutputLanguagePolicy } from "./language-policy"
import {
  buildCompactSummaryRequest,
  buildLocalResponsesCompaction,
} from "./responses-compact-fallback"
import {
  buildImagesEditResponsesBodyFromFormData,
  buildImagesEditResponsesBodyFromJson,
  buildImagesGenerationResponsesBody,
  imagesApiResponseFromResponses,
  isImagesApiPath,
  isImagesEditsPath,
  isImagesGenerationsPath,
} from "./image-api"
import { sanitizeImagesForTargetModel } from "./media-sanitizer"
import { normalizeUpstreamErrorPayload } from "./upstream-error"
import {
  ProxyRequestBodyError,
  readDecodedFormDataRequest,
  readDecodedJsonRequest,
} from "./content-encoding"
import type { OpenAICompatibleBuiltRequest } from "./openai-compatible"
import { recordCodexChatResponse } from "./codex-chat-history"
import {
  createChatToResponsesSseStream,
  transformChatCompatibleResponse,
} from "./chat-compatible"
import {
  createNativeSseStreamToClient,
} from "./native-sse"
import {
  buildChatCompletionPayload,
  createChatCompletionsSseStream,
  createResponsesSseRepairStream,
  extractFinalResponseFromSse,
  transformResponsesSseText,
} from "./responses-sse"
import { restoreCompatibleResponsesToolCalls } from "./responses-tool-search-compat"
import {
  createQwenResponsesDiagnosticStream,
  writeQwenResponsesStreamFallthroughDiagnostic,
} from "./qwen-responses-diagnostics"
import {
  toOpenAIChatFromAnthropic,
  toOpenAIResponseFromAnthropic,
} from "./anthropic"
import {
  toOpenAIChatFromGemini,
  toOpenAIResponseFromGemini,
} from "./gemini"
import {
  extractTokenUsage,
  TokenUsageSseCollector,
} from "./token-usage"
import { lastCompleteSseFrameBoundary } from "./sse-frame"
import {
  buildProxyRequest,
  fetchWithProviderTimeout,
  parseJsonSafe,
  type BuiltProxyRequest,
} from "./request-builder"
import {
  fetchWithModelCapacityRetry,
  MODEL_CAPACITY_MAX_RETRIES,
} from "./model-capacity-retry"
import { applyAuxiliaryRouting } from "./auxiliary-routing"
import {
  maybeRectifyUpstreamError,
  type RectifierKind,
} from "./request-rectifiers"
import {
  executeRelayWebSearch,
  isHostedWebSearchToolType,
  RELAY_WEB_SEARCH_TOOL_NAME,
  type RelayWebSearchInput,
} from "./web-search-relay"

const SUPPORTED_POST_PATHS = new Set([
  "v1/chat/completions",
  "v1/images/edits",
  "v1/images/generations",
  "v1/responses",
  "v1/responses/compact",
  "chat/completions",
  "images/edits",
  "images/generations",
  "responses",
  "responses/compact",
])

type BuiltRequest = BuiltProxyRequest
type ParsedImageApiRequest = Awaited<ReturnType<typeof parseImagesApiRequest>>
type AnyRecord = Record<string, any>

const WEB_SEARCH_RELAY_MAX_TURNS = 3

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function responseFailedError(failed: unknown, fallbackMessage: string) {
  const record = failed && typeof failed === "object" ? (failed as Record<string, any>) : {}
  const error = record.error && typeof record.error === "object"
    ? (record.error as Record<string, any>)
    : record
  const message =
    typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : fallbackMessage
  const type =
    typeof error.type === "string" && error.type.trim()
      ? error.type.trim()
      : "server_error"
  return { message, type }
}

function normalizePath(parts: string[]) {
  const normalized = parts.map((part) => part.trim()).filter(Boolean)
  if (normalized[0]?.toLowerCase() === "codex") normalized.shift()
  while (
    normalized.length >= 2 &&
    normalized[0]?.toLowerCase() === "v1" &&
    normalized[1]?.toLowerCase() === "v1"
  ) {
    normalized.splice(0, 1)
  }
  return normalized.join("/")
}

function makeLog(params: {
  startedAt: number
  body: unknown
  target: ProxyTarget
  statusCode: number
  rewrittenBody?: unknown
  responseSummary: string
  tokenUsage?: TokenUsage
  error?: string
  errorStack?: string
}): RequestLog {
  const log: RequestLog = {
    id: `log-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date(params.startedAt).toISOString(),
    codexModel: params.target.requestedModel,
    finalProviderId: params.target.provider.id,
    finalModelId: params.target.modelId,
    reasoning: params.target.reasoning,
    statusCode: params.statusCode,
    durationMs: Date.now() - params.startedAt,
    tokenUsage: params.tokenUsage,
    error: params.error,
    rawRequest: compactJson(params.body),
    rewrittenRequest: params.rewrittenBody
      ? compactJson(params.rewrittenBody)
      : "请求尚未改写",
    responseSummary: params.responseSummary,
    errorStack: params.errorStack,
  }
  registerLanguagePolicyDiagnosticSource(log, {
    rawBody: params.body,
    rewrittenBody: params.rewrittenBody,
    responseSummary: params.responseSummary,
    expectChinesePolicy: shouldApplyOutputLanguagePolicy(params.target),
  })
  registerRequestLogDetailSource(log, {
    enabled: params.target.fullRequestLoggingEnabled === true,
    rawBody: params.body,
    rewrittenBody: params.rewrittenBody,
  })
  return log
}

function makeEarlyFailureLog(params: {
  startedAt: number
  path: string
  request: Request
  body?: unknown
  statusCode: number
  responseSummary: string
  error: string
  errorStack?: string
}): RequestLog {
  const contentLength = params.request.headers.get("content-length") || ""
  const contentEncoding = params.request.headers.get("content-encoding") || ""
  const contentType = params.request.headers.get("content-type") || ""
  const requestMeta = {
    path: params.path,
    method: params.request.method,
    contentLength,
    contentEncoding,
    contentType,
    url: params.request.url,
    body: params.body,
  }
  const log: RequestLog = {
    id: `log-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date(params.startedAt).toISOString(),
    codexModel: "<unresolved>",
    finalProviderId: "<unresolved>",
    finalModelId: "<unresolved>",
    reasoning: "off",
    statusCode: params.statusCode,
    durationMs: Date.now() - params.startedAt,
    error: params.error,
    rawRequest: compactJson(requestMeta),
    rewrittenRequest: "请求尚未解析到目标供应商",
    responseSummary: params.responseSummary,
    errorStack: params.errorStack,
  }
  registerLanguagePolicyDiagnosticSource(log, {
    rawBody: requestMeta,
    rewrittenBody: undefined,
    responseSummary: params.responseSummary,
    expectChinesePolicy: false,
  })
  return log
}

function appendLogDetached(log: RequestLog) {
  void appendRequestLogDetails(log).catch(() => undefined)
  void appendLanguagePolicyDiagnostic(log).catch(() => undefined)
  void appendLog(log).catch(() => undefined)
}

function appendLogAfterStreamSettles(
  stream: ReadableStream<Uint8Array>,
  params: Parameters<typeof makeLog>[0],
) {
  const collector = new TokenUsageSseCollector()
  const reader = stream.getReader()
  let logged = false

  const errorMessage = (error?: unknown) => {
    if (error instanceof Error) return error.message
    if (typeof error === "string" && error.trim()) return error.trim()
    if (error != null) return String(error)
    return params.error
  }

  const streamTerminalError = (fallback: string) => {
    const terminal = collector.terminal()
    if (terminal === "completed") return undefined
    if (terminal === "failed") return "流式响应返回 response.failed，未完成 response.completed"
    return `${fallback}；terminal=${terminal || "none"}`
  }

  const writeLog = (tokenUsage?: TokenUsage, error?: unknown) => {
    if (logged) return
    logged = true
    const message = errorMessage(error)
    appendLogDetached(
      makeLog({
        ...params,
        tokenUsage: tokenUsage || params.tokenUsage,
        error: message,
        errorStack: error instanceof Error ? error.stack : params.errorStack,
      }),
    )
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          const usage = collector.finish()
          writeLog(usage, streamTerminalError("流式响应结束但没有看到 response.completed"))
          controller.close()
          return
        }
        if (value?.length) collector.push(value)
        if (value) controller.enqueue(value)
      } catch (error) {
        writeLog(collector.current() || params.tokenUsage, error)
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        writeLog(
          collector.current() || params.tokenUsage,
          reason || streamTerminalError("客户端取消读取流式响应"),
        )
      }
    },
  })
}

async function streamBodyMissingResponse(params: Parameters<typeof makeLog>[0]) {
  const message = "上游没有提供可读的流式响应体"
  appendLogDetached(
    makeLog({
      ...params,
      statusCode: 502,
      responseSummary: message,
      error: message,
    }),
  )
  return Response.json(
    { error: { message, type: "server_error" } },
    { status: 502 },
  )
}

function withResponseModel(payload: unknown, model: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>), model }
  if (next.response && typeof next.response === "object" && !Array.isArray(next.response)) {
    next.response = { ...(next.response as Record<string, unknown>), model }
  }
  return next
}

function applyAssistantMessagePhaseToResponsePayload(payload: unknown) {
  if (!isObject(payload)) return
  const root = isObject(payload.response) ? payload.response : payload
  applyAssistantMessagePhase(root.output)
}

function transformResponse(
  target: ProxyTarget,
  path: string,
  payload: unknown,
  built?: BuiltRequest,
  options: { recordHistory?: boolean } = {},
) {
  const shouldRecordHistory = options.recordHistory !== false
  if (isOpenAIResponsesProtocol(target.provider.protocol)) {
    if (built?.adapter?.type === "chat_completions") {
      return buildChatCompletionPayload(
        payload,
        built.adapter.requestedModel,
        built.adapter.reverseToolNameMap,
      )
    }
    if (isResponsesCompactPath(path)) return payload
    const restored = built?.adapter?.type === "passthrough" && !target.provider.rawResponsesPassthrough
      ? restoreCompatibleResponsesToolCalls(payload, built.adapter.toolContext)
      : payload
    const transformed = built?.adapter?.type === "passthrough"
      ? withResponseModel(restored, built.adapter.responseModelOverride || target.requestedModel)
      : restored
    if (!target.provider.rawResponsesPassthrough) {
      applyAssistantMessagePhaseToResponsePayload(transformed)
    }
    if (shouldRecordHistory && isResponsesPath(path)) {
      recordCodexChatResponse(transformed, built?.rewrittenBody)
    }
    return transformed
  }
  if (isOpenAIChatProtocol(target.provider.protocol)) {
    return built?.adapter?.type === "chat_compatible" ||
      built?.adapter?.type === "chat_compatible_passthrough"
      ? transformChatCompatibleResponse(payload, built.adapter, {
          recordHistory: shouldRecordHistory,
        })
      : payload
  }
  const isResponses = isResponsesPath(path)
  if (target.provider.protocol === "anthropic") {
    const transformed = isResponses
      ? toOpenAIResponseFromAnthropic(
          payload,
          built?.adapter?.type === "native" ? built.adapter.requestedModel : target.requestedModel,
          built?.adapter?.type === "native"
            ? {
                reverseToolNameMap: built.adapter.reverseToolNameMap,
                toolContext: built.adapter.toolContext,
              }
            : undefined,
        )
      : toOpenAIChatFromAnthropic(
          payload,
          target.modelId,
          built?.adapter?.type === "native"
            ? built.adapter.requestedModel
            : target.requestedModel,
          built?.adapter?.type === "native" ? built.adapter.reverseToolNameMap : {},
          built?.adapter?.type === "native" ? built.adapter.toolContext : undefined,
        )
    if (shouldRecordHistory && isResponses) {
      recordCodexChatResponse(
        transformed,
        built?.adapter?.type === "native"
          ? built.adapter.historyRequestBody
          : built?.rewrittenBody,
      )
    }
    return transformed
  }
  if (target.provider.protocol === "gemini") {
    const transformed = isResponses
      ? toOpenAIResponseFromGemini(
          payload,
          built?.adapter?.type === "native" ? built.adapter.requestedModel : target.requestedModel,
          built?.adapter?.type === "native"
            ? {
                reverseToolNameMap: built.adapter.reverseToolNameMap,
                toolContext: built.adapter.toolContext,
              }
            : undefined,
        )
      : toOpenAIChatFromGemini(
          payload,
          target.modelId,
          built?.adapter?.type === "native"
            ? built.adapter.requestedModel
            : target.requestedModel,
          built?.adapter?.type === "native" ? built.adapter.reverseToolNameMap : {},
          built?.adapter?.type === "native" ? built.adapter.toolContext : undefined,
        )
    if (shouldRecordHistory && isResponses) {
      recordCodexChatResponse(
        transformed,
        built?.adapter?.type === "native"
          ? built.adapter.historyRequestBody
          : built?.rewrittenBody,
      )
    }
    return transformed
  }
  return payload
}

function parseSseFrames(text: string) {
  return String(text || "")
    .trimStart()
    .replace(/^\uFEFF/, "")
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      const data: string[] = []
      for (const rawLine of frame.split(/\r?\n/)) {
        const line = rawLine.trimStart()
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
      return data.join("\n")
    })
    .filter(Boolean)
}

function recordResponsesSseText(text: string, requestBody?: unknown) {
  for (const payload of parseSseFrames(text)) {
    if (!payload || payload === "[DONE]") continue
    if (
      !payload.includes('"response.completed"') &&
      !payload.includes('"response.output_item.done"')
    ) {
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(payload)
    } catch {
      continue
    }
    if (!value || typeof value !== "object") continue
    const record = value as Record<string, any>
    if (record.type === "response.completed") {
      recordCodexChatResponse(record.response, requestBody)
    } else if (record.type === "response.output_item.done") {
      const responseId = record.response?.id || record.item?.response_id
      if (responseId && record.item) {
        recordCodexChatResponse({ id: responseId, output: [record.item] })
      }
    }
  }
}

function createResponsesHistoryRecorderStream(requestBody?: unknown) {
  const decoder = new TextDecoder()
  let buffer = ""
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })
      buffer += text
      const boundary = lastCompleteSseFrameBoundary(buffer)
      if (boundary) {
        const end = boundary.index + boundary.separatorLength
        const head = buffer.slice(0, end)
        buffer = buffer.slice(end)
        recordResponsesSseText(head, requestBody)
      }
      controller.enqueue(chunk)
    },
    flush() {
      const tail = decoder.decode()
      if (tail) {
        buffer += tail
      }
      if (buffer) recordResponsesSseText(buffer, requestBody)
    },
  })
}

async function maybeAdaptNativeStream(
  upstream: Response,
  built: BuiltRequest,
  startedAt: number,
  body: unknown,
  target: ProxyTarget,
) {
  const adapter = built.adapter
  if (!adapter || adapter.type !== "native" || !adapter.requestIsStream) return null

  const source = upstream.body
  if (!source) {
    return streamBodyMissingResponse({
      startedAt,
      body,
      target,
      statusCode: upstream.status,
      rewrittenBody: built.rewrittenBody,
      responseSummary: "native streaming response adapted",
    })
  }

  const adaptedStream = source.pipeThrough(
    createNativeSseStreamToClient({
      adapter,
      model: target.requestedModel,
    }),
  )
  const stream =
    adapter.source === "responses"
      ? adaptedStream.pipeThrough(
          createResponsesHistoryRecorderStream(adapter.historyRequestBody),
        )
      : adaptedStream
  const loggedStream = appendLogAfterStreamSettles(stream, {
    startedAt,
    body,
    target,
    statusCode: upstream.status,
    rewrittenBody: built.rewrittenBody,
    responseSummary: "native streaming response adapted",
  })
  return new Response(loggedStream, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-codex-hot-switch-provider": target.provider.id,
      "x-codex-hot-switch-model": target.modelId,
    },
  })
}

async function maybeAdaptChatCompatibleStream(
  upstream: Response,
  built: BuiltRequest,
  startedAt: number,
  body: unknown,
  target: ProxyTarget,
) {
  const adapter = built.adapter
  if (
    !adapter ||
    (adapter.type !== "chat_compatible" &&
      adapter.type !== "chat_compatible_passthrough") ||
    !adapter.requestIsStream
  ) {
    return null
  }

  if (adapter.type === "chat_compatible_passthrough") {
    const source = upstream.body
    if (!source) {
      return streamBodyMissingResponse({
        startedAt,
        body,
        target,
        statusCode: upstream.status,
        rewrittenBody: built.rewrittenBody,
        responseSummary: "chat streaming response relayed",
      })
    }
    const loggedStream = appendLogAfterStreamSettles(source, {
      startedAt,
      body,
      target,
      statusCode: upstream.status,
      rewrittenBody: built.rewrittenBody,
      responseSummary: "chat streaming response relayed",
    })
    return new Response(loggedStream, {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "x-codex-hot-switch-provider": target.provider.id,
        "x-codex-hot-switch-model": target.modelId,
      },
    })
  }

  const source = upstream.body
  if (!source) {
    return streamBodyMissingResponse({
      startedAt,
      body,
      target,
      statusCode: upstream.status,
      rewrittenBody: built.rewrittenBody,
      responseSummary: "chat streaming response adapted",
    })
  }

  const stream = source.pipeThrough(createChatToResponsesSseStream(adapter))
  const loggedStream = appendLogAfterStreamSettles(stream, {
    startedAt,
    body,
    target,
    statusCode: upstream.status,
    rewrittenBody: built.rewrittenBody,
    responseSummary: "chat streaming response adapted",
  })
  return new Response(loggedStream, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-codex-hot-switch-provider": target.provider.id,
      "x-codex-hot-switch-model": target.modelId,
    },
  })
}

async function maybeAdaptOpenAICompatibleStream(
  upstream: Response,
  built: OpenAICompatibleBuiltRequest,
  startedAt: number,
  body: unknown,
  target: ProxyTarget,
) {
  const adapter = built.adapter

  if (adapter.type === "chat_completions" && !adapter.stream) {
    const text = await upstream.text()
    const repaired = transformResponsesSseText(text)
    const capture = extractFinalResponseFromSse(repaired.text)
    if (!capture.final) {
      const failed = responseFailedError(capture.failed, "上游没有返回完整 response.completed")
      appendLogDetached(
        makeLog({
          startedAt,
          body,
          target,
          statusCode: 502,
          rewrittenBody: built.rewrittenBody,
          responseSummary: compactJson(capture.failed) || failed.message,
          error: failed.message,
        }),
      )
      return Response.json(
        { error: failed },
        { status: 502 },
      )
    }
    const payload = buildChatCompletionPayload(
      capture.final,
      adapter.requestedModel,
      adapter.reverseToolNameMap,
    )
    appendLogDetached(
      makeLog({
        startedAt,
        body,
        target,
        statusCode: upstream.status,
        rewrittenBody: built.rewrittenBody,
        responseSummary: compactJson(payload),
        tokenUsage: extractTokenUsage(payload),
      }),
    )
    return Response.json(payload, {
      status: upstream.status,
      headers: {
        "x-codex-hot-switch-provider": target.provider.id,
        "x-codex-hot-switch-model": target.modelId,
      },
    })
  }

  if (adapter.type === "passthrough" && !adapter.requestIsStream) {
    return null
  }

  const source = upstream.body
  if (!source) {
    return streamBodyMissingResponse({
      startedAt,
      body,
      target,
      statusCode: upstream.status,
      rewrittenBody: built.rewrittenBody,
      responseSummary: "streaming response relayed",
    })
  }

  const diagnosticSource = createQwenResponsesDiagnosticStream(source, {
    startedAt,
    target,
    statusCode: upstream.status,
    rewrittenBody: built.rewrittenBody,
  })

  const stream =
    adapter.type === "chat_completions"
      ? diagnosticSource
          .pipeThrough(createResponsesSseRepairStream({
            synthesizeFinalOnStreamEnd: true,
          }))
          .pipeThrough(
            createChatCompletionsSseStream(
              adapter.requestedModel,
              adapter.reverseToolNameMap,
            ),
          )
      : diagnosticSource.pipeThrough(
          createResponsesSseRepairStream({
            modelOverride: adapter.responseModelOverride,
            synthesizeFinalOnStreamEnd: true,
            toolContext: adapter.toolContext,
            assistantMessagePhase: !target.provider.rawResponsesPassthrough,
          }),
        )
  const recordedStream =
    adapter.type === "chat_completions"
      ? stream
      : stream.pipeThrough(createResponsesHistoryRecorderStream(built.rewrittenBody))

  const loggedStream = appendLogAfterStreamSettles(recordedStream, {
    startedAt,
    body,
    target,
    statusCode: upstream.status,
    rewrittenBody: built.rewrittenBody,
    responseSummary: "streaming response relayed",
  })
  return new Response(loggedStream, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-codex-hot-switch-provider": target.provider.id,
      "x-codex-hot-switch-model": target.modelId,
    },
  })
}

async function imagesApiJsonResponse(params: {
  upstream: Response
  built: BuiltRequest
  startedAt: number
  rawBody: unknown
  target: ProxyTarget
  responseFormat: string
}) {
  const text = await params.upstream.text()
  const parsedJson = (() => {
    if (!text.trim()) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  })()
  if (parsedJson) {
    const payload = imagesApiResponseFromResponses(parsedJson, params.responseFormat)
    appendLogDetached(
      makeLog({
        startedAt: params.startedAt,
        body: params.rawBody,
        target: params.target,
        statusCode: params.upstream.status,
        rewrittenBody: params.built.rewrittenBody,
        responseSummary: compactJson(payload),
        tokenUsage: extractTokenUsage(payload) || extractTokenUsage(parsedJson),
      }),
    )
    return Response.json(payload, {
      status: params.upstream.status,
      headers: {
        "x-codex-hot-switch-provider": params.target.provider.id,
        "x-codex-hot-switch-model": params.target.modelId,
      },
    })
  }

  const repaired = transformResponsesSseText(text)
  const capture = extractFinalResponseFromSse(repaired.text)
  if (!capture.final) {
    const failed = responseFailedError(capture.failed, "上游没有返回完整图片 response.completed")
    appendLogDetached(
      makeLog({
        startedAt: params.startedAt,
        body: params.rawBody,
        target: params.target,
        statusCode: 502,
        rewrittenBody: params.built.rewrittenBody,
        responseSummary: compactJson(capture.failed) || failed.message,
        error: failed.message,
      }),
    )
    return Response.json(
      { error: failed },
      { status: 502 },
    )
  }

  const payload = imagesApiResponseFromResponses(capture.final, params.responseFormat)
  appendLogDetached(
    makeLog({
      startedAt: params.startedAt,
      body: params.rawBody,
      target: params.target,
      statusCode: params.upstream.status,
      rewrittenBody: params.built.rewrittenBody,
      responseSummary: compactJson(payload),
      tokenUsage:
        extractTokenUsage(payload) ||
        extractTokenUsage(capture.final) ||
        extractTokenUsage(capture.usage),
    }),
  )
  return Response.json(payload, {
    status: params.upstream.status,
    headers: {
      "x-codex-hot-switch-provider": params.target.provider.id,
      "x-codex-hot-switch-model": params.target.modelId,
    },
  })
}

async function parseImagesApiRequest(path: string, request: Request) {
  if (isImagesGenerationsPath(path)) {
    return buildImagesGenerationResponsesBody(await readDecodedJsonRequest(request))
  }
  if (!isImagesEditsPath(path)) return null

  const contentType = request.headers.get("content-type") || ""
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    return buildImagesEditResponsesBodyFromFormData(await readDecodedFormDataRequest(request))
  }
  return buildImagesEditResponsesBodyFromJson(await readDecodedJsonRequest(request))
}

async function maybeHandleSuccessfulUpstream(params: {
  imageApiRequest: ParsedImageApiRequest | null
  upstream: Response
  built: BuiltRequest
  startedAt: number
  rawBody: unknown
  target: ProxyTarget
  path: string
  capacityRetryCount?: number
}) {
  const {
    imageApiRequest,
    upstream,
    built,
    startedAt,
    rawBody,
    target,
    path,
    capacityRetryCount = 0,
  } = params

  if (!upstream.ok) return null

  if (
    imageApiRequest &&
    isOpenAIResponsesProtocol(target.provider.protocol) &&
    !imageApiRequest.stream
  ) {
    return await imagesApiJsonResponse({
      upstream,
      built,
      startedAt,
      rawBody,
      target,
      responseFormat: imageApiRequest.responseFormat,
    })
  }

  if (
    isOpenAIResponsesProtocol(target.provider.protocol) &&
    built.adapter
  ) {
    if (
      target.provider.rawResponsesPassthrough &&
      isResponsesPath(path) &&
      built.adapter.type === "passthrough" &&
      built.adapter.requestIsStream &&
      upstream.body
    ) {
      const rawStream = upstream.body
        .pipeThrough(
          createResponsesSseRepairStream({
            modelOverride: built.adapter.responseModelOverride,
            synthesizeFinalOnStreamEnd: true,
          }),
        )
        .pipeThrough(createResponsesHistoryRecorderStream(built.rewrittenBody))
      const loggedStream = appendLogAfterStreamSettles(rawStream, {
        startedAt,
        body: rawBody,
        target,
        statusCode: upstream.status,
        rewrittenBody: built.rewrittenBody,
        responseSummary:
          capacityRetryCount > 0
            ? `OpenAI Responses raw stream passthrough；模型容量重试 ${capacityRetryCount} 次`
            : "OpenAI Responses raw stream passthrough",
      })
      return new Response(loggedStream, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") || "text/event-stream",
          "x-codex-hot-switch-provider": target.provider.id,
          "x-codex-hot-switch-model": target.modelId,
          "x-codex-hot-switch-raw-responses-passthrough": "1",
          ...(capacityRetryCount > 0
            ? { "x-codex-hot-switch-capacity-retries": String(capacityRetryCount) }
            : {}),
        },
      })
    }
    const streamResponse = await maybeAdaptOpenAICompatibleStream(
      upstream,
      built as OpenAICompatibleBuiltRequest,
      startedAt,
      rawBody,
      target,
    )
    if (streamResponse) return streamResponse
  }

  if (isOpenAIChatProtocol(target.provider.protocol) && built.adapter) {
    const streamResponse = await maybeAdaptChatCompatibleStream(
      upstream,
      built,
      startedAt,
      rawBody,
      target,
    )
    if (streamResponse) return streamResponse
  }

  if (built.adapter?.type === "native") {
    const streamResponse = await maybeAdaptNativeStream(
      upstream,
      built,
      startedAt,
      rawBody,
      target,
    )
    if (streamResponse) return streamResponse
  }

  return null
}

function withRewrittenBody(built: BuiltRequest, rewrittenBody: unknown): BuiltRequest {
  return {
    ...built,
    rewrittenBody,
    init: {
      ...built.init,
      body: JSON.stringify(rewrittenBody),
    },
  }
}

function requestDeclaresHostedWebSearch(body: unknown) {
  if (!isObject(body) || !Array.isArray(body.tools)) return false
  return body.tools.some((tool) => isObject(tool) && isHostedWebSearchToolType(tool.type))
}

function requestForcesHostedWebSearch(body: unknown) {
  if (!isObject(body)) return false
  const choice = body.tool_choice
  if (typeof choice === "string") return isHostedWebSearchToolType(choice)
  if (!isObject(choice)) return false
  if (isHostedWebSearchToolType(choice.type)) return true
  if (choice.type === "function") {
    const name = String(choice.name || choice.function?.name || "").trim()
    return name === RELAY_WEB_SEARCH_TOOL_NAME
  }
  return false
}

function textFromSearchIntentContent(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map(textFromSearchIntentContent).filter(Boolean).join("\n")
  }
  if (!isObject(value)) return ""
  const direct = typeof value.text === "string"
    ? value.text
    : typeof value.content === "string"
      ? value.content
      : typeof value.input === "string"
        ? value.input
        : ""
  const nested = Array.isArray(value.content)
    ? textFromSearchIntentContent(value.content)
    : ""
  return [direct, nested].filter(Boolean).join("\n")
}

function latestUserInputText(body: unknown) {
  if (!isObject(body)) return ""
  const input = body.input
  if (typeof input === "string") return input
  const items = Array.isArray(input) ? input : input == null ? [] : [input]
  let latest = ""
  for (const item of items) {
    if (typeof item === "string") {
      latest = item
      continue
    }
    if (!isObject(item)) continue
    const role = String(item.role || "").trim().toLowerCase()
    const type = String(item.type || "").trim().toLowerCase()
    if (role && role !== "user") continue
    if (!role && type !== "message" && type !== "input_text") continue
    const text = type === "input_text"
      ? textFromSearchIntentContent(item)
      : textFromSearchIntentContent(item.content)
    if (text.trim()) latest = text
  }
  return latest
}

function requestHasExplicitHostedWebSearchIntent(body: unknown) {
  const text = latestUserInputText(body).slice(-4000)
  if (!text.trim()) return false
  const toolDebug =
    /(?:web_search|web search|tool_search|搜索工具|搜索tool).{0,24}(?:不可用|不能用|没暴露|没有暴露|没注册|没有注册|定义|中转|工具)/i.test(text) ||
    /(?:不可用|不能用|没暴露|没有暴露|没注册|没有注册|定义|中转|工具).{0,24}(?:web_search|web search|tool_search|搜索工具|搜索tool)/i.test(text)
  const explicitToolUse = /(?:用|使用|调用|执行|跑|试试|试一下|测试).{0,24}(?:web_search|web search|搜索工具|联网搜索)/i.test(text)
  if (toolDebug && !explicitToolUse) return false
  if (explicitToolUse) return true

  const explicitWeb =
    /(?:联网|上网|全网|外网|互联网|网页搜索|网络搜索|搜索网页|搜索网络|查官网|看官网|官网|官方网站|网站|网页|链接|url|https?:\/\/|www\.|github|gitlab|google|bing|百度|必应|search the web|browse the web|look up online|online search)/i
  if (explicitWeb.test(text)) return true

  const localCodeTask =
    /(?:只允许修改|允许修改|禁止修改|验收命令|不要提交 git|worktree|pyproject\.toml|uv\.lock|pytest|docs\/|data\/|engine\/src|engine\/tests)/i
  if (localCodeTask.test(text)) return false

  const action =
    /(?:搜|搜索|检索|查询|查一下|查下|查查|查找|查阅|查证|核实|核对|验证|确认|看看|看一下|帮我看|look up|search|find out|check|verify|confirm)/i
  const externalContext =
    /(?:最新|最近|当前|现在|今天|昨日|昨天|明天|本周|本月|实时|新闻|公告|发布|上线|更新|版本|release|changelog|github|issue|pull request|npm|pypi|pip|官网|网站|网页|价格|行情|汇率|政策|法规|规则|标准|排名|榜单|论文|paper|资料|来源|出处)/i
  return action.test(text) && externalContext.test(text)
}

function requestAllowsHostedWebSearchRelay(body: unknown) {
  return requestForcesHostedWebSearch(body) || requestHasExplicitHostedWebSearchIntent(body)
}

function shouldStripHostedWebSearch(
  target: ProxyTarget,
  path: string,
  body: unknown,
  webSearchMode: WebSearchMode,
) {
  if (!isResponsesPath(path)) return false
  if (!requestDeclaresHostedWebSearch(body)) return false
  if (isOpenAIResponsesProtocol(target.provider.protocol) && target.provider.rawResponsesPassthrough) {
    return false
  }
  if (webSearchMode !== "builtin") return true
  return !requestAllowsHostedWebSearchRelay(body)
}

function stripHostedWebSearchTools(body: unknown) {
  if (!isObject(body) || !Array.isArray(body.tools)) return body
  const tools = body.tools.filter(
    (tool) => !(isObject(tool) && isHostedWebSearchToolType(tool.type)),
  )
  if (tools.length === body.tools.length) return body
  const next: AnyRecord = { ...body }
  if (tools.length > 0) next.tools = tools
  else {
    delete next.tools
    if (next.tool_choice === "required") delete next.tool_choice
  }
  return next
}

function shouldRelayWebSearch(
  target: ProxyTarget,
  path: string,
  body: unknown,
  webSearchMode: WebSearchMode,
) {
  if (webSearchMode !== "builtin") return false
  if (!isResponsesPath(path)) return false
  if (!requestDeclaresHostedWebSearch(body)) return false
  if (!requestAllowsHostedWebSearchRelay(body)) return false
  return !(isOpenAIResponsesProtocol(target.provider.protocol) && target.provider.rawResponsesPassthrough)
}

function requestWantsStream(body: unknown) {
  return isObject(body) && body.stream === true
}

function shouldDiagnoseOpenAIResponsesStreamFallthrough(params: {
  target: ProxyTarget
  path: string
  body: unknown
  built: BuiltRequest
  upstream: Response
}) {
  if (!params.upstream.ok) return false
  if (!isOpenAIResponsesProtocol(params.target.provider.protocol)) return false
  if (params.target.provider.rawResponsesPassthrough) return false
  if (!isResponsesPath(params.path)) return false
  if (requestWantsStream(params.body)) return true
  const rewrittenBody = params.built.rewrittenBody
  if (isObject(rewrittenBody) && rewrittenBody.stream === true) return true
  const adapter = params.built.adapter
  if (!adapter) return false
  if (adapter.type === "chat_completions") return adapter.stream === true
  if (adapter.type === "passthrough") return adapter.requestIsStream === true
  return false
}

function isOpenAIOfficialProvider(target: ProxyTarget) {
  if (target.provider.id === "openai-official") return true
  if (target.provider.name.toLowerCase().includes("openai 官方")) return true
  try {
    return new URL(target.provider.baseUrl).hostname.toLowerCase() === "api.openai.com"
  } catch {
    return false
  }
}

function shouldHandleCompactLocally(target: ProxyTarget, path: string) {
  if (!isResponsesCompactPath(path)) return false
  return !(
    isOpenAIResponsesProtocol(target.provider.protocol) &&
    (target.provider.rawResponsesPassthrough === true || isOpenAIOfficialProvider(target))
  )
}

async function handleResponsesCompactFallback(params: {
  body: unknown
  rawBody: unknown
  target: ProxyTarget
  startedAt: number
  requestSignal?: AbortSignal
}) {
  if (!isObject(params.body)) {
    throw new ProxyRequestBodyError("responses/compact 请求体必须是合法 JSON 对象", 400)
  }
  if (params.body.stream === true) {
    throw new ProxyRequestBodyError("OpenAI Responses compact 不支持 stream=true", 400)
  }
  const summaryBody = buildCompactSummaryRequest(params.body, params.target.modelId)
  const summaryTarget: ProxyTarget = { ...params.target, reasoning: "off" }
  const built = buildProxyRequest(summaryTarget, "v1/responses", summaryBody)
  let upstream: Response
  try {
    upstream = await fetchWithProviderTimeout(summaryTarget, built, params.requestSignal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const transformed = {
      error: {
        message,
        type: "server_error",
      },
    }
    appendLogDetached(
      makeLog({
        startedAt: params.startedAt,
        body: params.rawBody,
        target: summaryTarget,
        statusCode: 502,
        rewrittenBody: built.rewrittenBody,
        responseSummary: compactJson(transformed),
        error: `compact 摘要请求失败：${message}`,
      }),
    )
    return Response.json(transformed, {
      status: 502,
      headers: {
        "x-codex-hot-switch-provider": summaryTarget.provider.id,
        "x-codex-hot-switch-model": summaryTarget.modelId,
        "x-codex-hot-switch-compact-fallback": "summary_failed",
      },
    })
  }
  const payload = await parseJsonSafe(upstream)

  if (!upstream.ok) {
    const transformed = normalizeUpstreamErrorPayload(payload, upstream.status)
    appendLogDetached(
      makeLog({
        startedAt: params.startedAt,
        body: params.rawBody,
        target: summaryTarget,
        statusCode: upstream.status,
        rewrittenBody: built.rewrittenBody,
        responseSummary: compactJson(transformed),
        error: `compact 摘要上游返回 HTTP ${upstream.status} ${upstream.statusText}`,
      }),
    )
    return Response.json(transformed, {
      status: upstream.status,
      headers: {
        "x-codex-hot-switch-provider": params.target.provider.id,
        "x-codex-hot-switch-model": params.target.modelId,
        "x-codex-hot-switch-compact-fallback": "summary_failed",
      },
    })
  }

  const transformed = transformResponse(summaryTarget, "v1/responses", payload, built, {
    recordHistory: false,
  })
  const summary = responseOutputText(transformed)
  const compactResponse = buildLocalResponsesCompaction(
    summary,
    extractTokenUsage(transformed) || extractTokenUsage(payload),
  )
  appendLogDetached(
    makeLog({
      startedAt: params.startedAt,
      body: params.rawBody,
      target: summaryTarget,
      statusCode: 200,
      rewrittenBody: built.rewrittenBody,
      responseSummary: compactJson(compactResponse),
      tokenUsage: extractTokenUsage(compactResponse) || extractTokenUsage(transformed) || extractTokenUsage(payload),
    }),
  )
  return Response.json(compactResponse, {
    status: 200,
    headers: {
      "x-codex-hot-switch-provider": params.target.provider.id,
      "x-codex-hot-switch-model": params.target.modelId,
      "x-codex-hot-switch-compact-fallback": "summary",
    },
  })
}

function disableRequestStream(body: unknown) {
  return isObject(body) ? { ...body, stream: false } : body
}

function inputItemsFromBody(body: AnyRecord) {
  if (Array.isArray(body.input)) return [...body.input]
  if (body.input == null) return []
  if (typeof body.input === "string") {
    return [{ type: "message", role: "user", content: body.input }]
  }
  return [body.input]
}

function parsedArguments(value: unknown): AnyRecord {
  if (isObject(value)) return value
  if (typeof value !== "string" || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return isObject(parsed) ? parsed : { value: parsed }
  } catch {
    return { query: value }
  }
}

function relayInputFromCall(item: AnyRecord, target: ProxyTarget): RelayWebSearchInput {
  const args = parsedArguments(item.arguments)
  const query = String(
    item.action?.query ||
      args.query ||
      args.search_query ||
      args.q ||
      args.input ||
      "",
  ).trim()
  return {
    query,
    numResults: Number.isFinite(Number(args.numResults))
      ? Math.max(1, Math.min(20, Number(args.numResults)))
      : undefined,
    livecrawl:
      args.livecrawl === "preferred" || args.livecrawl === "fallback"
        ? args.livecrawl
        : undefined,
    type:
      args.type === "auto" || args.type === "fast" || args.type === "deep"
        ? args.type
        : undefined,
    contextMaxCharacters: Number.isFinite(Number(args.contextMaxCharacters))
      ? Math.max(1, Math.min(50_000, Number(args.contextMaxCharacters)))
      : undefined,
    sessionId: String(item.call_id || item.id || "").trim() || undefined,
    modelName: target.modelId,
  }
}

function extractRelayWebSearchCalls(response: unknown) {
  if (!isObject(response) || !Array.isArray(response.output)) return []
  return response.output
    .filter((item): item is AnyRecord => {
      if (!isObject(item)) return false
      if (item.type === "web_search_call") return true
      return item.type === "function_call" && item.name === RELAY_WEB_SEARCH_TOOL_NAME
    })
    .map((item, index) => ({
      item,
      callId: String(item.call_id || item.id || `call_web_search_${index}`).trim(),
      argumentsText:
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments || { query: item.action?.query || "" }),
    }))
}

function relayToolHistoryItems(params: {
  calls: Array<{ item: AnyRecord; callId: string; argumentsText: string }>
  results: Array<{ callId: string; output: string }>
}) {
  return params.calls.flatMap((call) => {
    const result = params.results.find((entry) => entry.callId === call.callId)
    return [
      {
        type: "function_call",
        call_id: call.callId,
        name: RELAY_WEB_SEARCH_TOOL_NAME,
        arguments: call.argumentsText || "{}",
      },
      {
        type: "function_call_output",
        call_id: call.callId,
        output: result?.output || "",
      },
    ]
  })
}

function responseAssistantHistoryItems(response: unknown) {
  if (!isObject(response) || !Array.isArray(response.output)) return []
  return response.output.filter(
    (item) => !(isObject(item) && (
      item.type === "web_search_call" ||
      (item.type === "function_call" && item.name === RELAY_WEB_SEARCH_TOOL_NAME)
    )),
  )
}

function nextRelayBody(
  body: unknown,
  response: unknown,
  calls: Array<{ item: AnyRecord; callId: string; argumentsText: string }>,
  results: Array<{ callId: string; output: string }>,
) {
  if (!isObject(body)) return body
  const next: AnyRecord = {
    ...body,
    stream: false,
    input: [
      ...inputItemsFromBody(body),
      ...responseAssistantHistoryItems(response),
      ...relayToolHistoryItems({ calls, results }),
    ],
  }
  delete next.previous_response_id
  if (
    next.tool_choice === "required" ||
    isHostedWebSearchToolType(next.tool_choice) ||
    (isObject(next.tool_choice) && isHostedWebSearchToolType(next.tool_choice.type))
  ) {
    next.tool_choice = "auto"
  }
  return next
}

function mergeRelayOutputItems(response: unknown, items: AnyRecord[]) {
  if (!items.length || !isObject(response)) return response
  const output = Array.isArray(response.output) ? response.output : []
  const existing = new Set(
    output
      .filter((item) => isObject(item))
      .map((item) => String(item.id || item.call_id || "")),
  )
  const merged = [
    ...items.filter((item) => !existing.has(String(item.id || item.call_id || ""))),
    ...output,
  ]
  return { ...response, output: merged }
}

function responseFromRelayPayload(payload: unknown, built: BuiltRequest) {
  if (typeof payload !== "string") return payload
  const text = payload.trimStart()
  if (!text.startsWith("event:") && !text.startsWith("data:")) return payload

  const repaired = transformResponsesSseText(text, {
    modelOverride:
      built.adapter?.type === "passthrough"
        ? built.adapter.responseModelOverride
        : undefined,
    synthesizeFinalOnStreamEnd: true,
    toolContext:
      built.adapter?.type === "passthrough"
        ? built.adapter.toolContext
        : undefined,
    assistantMessagePhase: true,
  })
  const capture = extractFinalResponseFromSse(repaired.text)
  return capture.final || capture.failed || payload
}

function responseOutputText(response: unknown) {
  if (!isObject(response)) return ""
  if (typeof response.output_text === "string" && response.output_text) return response.output_text
  if (!Array.isArray(response.output)) return ""
  return response.output
    .filter((item) => isObject(item) && item.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((part) => isObject(part) && typeof part.text === "string" ? part.text : "")
    .join("")
}

function sse(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

function responseToSse(response: unknown) {
  const root = isObject(response) ? response : {}
  const id = String(root.id || responseId("resp"))
  const model = String(root.model || "codex")
  const createdAt = Number(root.created_at) || Math.floor(Date.now() / 1000)
  let out =
    sse("response.created", {
      type: "response.created",
      response: {
        id,
        object: "response",
        created_at: createdAt,
        status: "in_progress",
        model,
        output: [],
      },
    }) +
    sse("response.in_progress", {
      type: "response.in_progress",
      response: {
        id,
        object: "response",
        created_at: createdAt,
        status: "in_progress",
        model,
        output: [],
      },
    })

  const output = Array.isArray(root.output) ? root.output : []
  output.forEach((item, index) => {
    if (!isObject(item)) return
    out += sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: index,
      item,
    })
    if (item.type === "message") {
      const text = Array.isArray(item.content)
        ? item.content
            .map((part) => isObject(part) && typeof part.text === "string" ? part.text : "")
            .join("")
        : ""
      if (text) {
        out += sse("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: item.id || `${id}_msg`,
          output_index: index,
          content_index: 0,
          delta: text,
        })
        out += sse("response.output_text.done", {
          type: "response.output_text.done",
          item_id: item.id || `${id}_msg`,
          output_index: index,
          content_index: 0,
          text,
        })
      }
    }
    out += sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: index,
      item,
    })
  })

  out += sse("response.completed", {
    type: "response.completed",
    response: {
      ...root,
      id,
      object: "response",
      created_at: createdAt,
      model,
      status: root.status || "completed",
      output,
      output_text: responseOutputText(root),
    },
  })
  out += "data: [DONE]\n\n"
  return out
}

function streamText(text: string) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

function errorResponseSse(params: {
  model: string
  message: string
  type?: string
  code?: string | number
}) {
  const id = responseId("resp")
  const createdAt = Math.floor(Date.now() / 1000)
  const failed = {
    id,
    object: "response",
    created_at: createdAt,
    status: "failed",
    model: params.model || "codex",
    output: [],
    error: {
      message: params.message,
      type: params.type || "server_error",
      ...(params.code != null ? { code: params.code } : {}),
    },
  }
  return [
    sse("response.created", {
      type: "response.created",
      response: {
        id,
        object: "response",
        created_at: createdAt,
        status: "in_progress",
        model: failed.model,
        output: [],
      },
    }),
    sse("response.failed", {
      type: "response.failed",
      response: failed,
    }),
    "data: [DONE]\n\n",
  ].join("")
}

function relayResponse(params: {
  response: unknown
  payload: unknown
  statusCode: number
  built: BuiltRequest
  startedAt: number
  rawBody: unknown
  target: ProxyTarget
  stream: boolean
}) {
  recordCodexChatResponse(params.response, params.built.rewrittenBody)
  appendLogDetached(
    makeLog({
      startedAt: params.startedAt,
      body: params.rawBody,
      target: params.target,
      statusCode: params.statusCode,
      rewrittenBody: params.built.rewrittenBody,
      responseSummary: compactJson(params.response),
      tokenUsage: extractTokenUsage(params.response) || extractTokenUsage(params.payload),
    }),
  )
  if (params.stream) {
    return new Response(streamText(responseToSse(params.response)), {
      status: params.statusCode,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "x-codex-hot-switch-provider": params.target.provider.id,
        "x-codex-hot-switch-model": params.target.modelId,
        "x-codex-hot-switch-web-search-relay": "1",
      },
    })
  }
  return Response.json(params.response, {
    status: params.statusCode,
    headers: {
      "x-codex-hot-switch-provider": params.target.provider.id,
      "x-codex-hot-switch-model": params.target.modelId,
      "x-codex-hot-switch-web-search-relay": "1",
    },
  })
}

function relayErrorHeaders(target: ProxyTarget, upstreamStatus: number) {
  return {
    "x-codex-hot-switch-provider": target.provider.id,
    "x-codex-hot-switch-model": target.modelId,
    "x-codex-hot-switch-web-search-relay": "1",
    "x-codex-hot-switch-upstream-error": String(upstreamStatus),
  }
}

function relayErrorResponse(params: {
  target: ProxyTarget
  stream: boolean
  statusCode: number
  message: string
  type?: string
  code?: string | number
}) {
  if (params.stream) {
    return new Response(
      streamText(
        errorResponseSse({
          model: params.target.requestedModel || params.target.modelId,
          message: params.message,
          type: params.type || "server_error",
          code: params.code,
        }),
      ),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "connection": "keep-alive",
          ...relayErrorHeaders(params.target, params.statusCode),
        },
      },
    )
  }
  return Response.json(
    {
      error: {
        message: params.message,
        type: params.type || "server_error",
        ...(params.code != null ? { code: params.code } : {}),
      },
    },
    {
      status: params.statusCode,
      headers: relayErrorHeaders(params.target, params.statusCode),
    },
  )
}

async function handleRelayWebSearchResponses(params: {
  path: string
  body: unknown
  rawBody: unknown
  target: ProxyTarget
  startedAt: number
  stream: boolean
  requestSignal?: AbortSignal
}) {
  let currentBody = disableRequestStream(params.body)
  let currentBuilt: BuiltRequest | undefined
  const relayedItems: AnyRecord[] = []

  for (let turn = 0; turn < WEB_SEARCH_RELAY_MAX_TURNS; turn += 1) {
    currentBuilt = buildProxyRequest(params.target, params.path, currentBody)
    let upstream: Response
    try {
      upstream = await fetchWithProviderTimeout(params.target, currentBuilt, params.requestSignal)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      appendLogDetached(
        makeLog({
          startedAt: params.startedAt,
          body: params.rawBody,
          target: params.target,
          statusCode: 502,
          rewrittenBody: currentBuilt.rewrittenBody,
          responseSummary: `web_search relay 请求失败：${message}`,
          error: message,
          errorStack: error instanceof Error ? error.stack : undefined,
        }),
      )
      return relayErrorResponse({
        target: params.target,
        stream: params.stream,
        statusCode: 502,
        message,
      })
    }
    const payload = await parseJsonSafe(upstream)

    if (!upstream.ok) {
      const transformed = normalizeUpstreamErrorPayload(payload, upstream.status)
      appendLogDetached(
        makeLog({
          startedAt: params.startedAt,
          body: params.rawBody,
          target: params.target,
          statusCode: upstream.status,
          rewrittenBody: currentBuilt.rewrittenBody,
          responseSummary: compactJson(transformed),
          error: `上游返回 HTTP ${upstream.status} ${upstream.statusText}`,
        }),
      )
      if (params.stream) {
        const upstreamError: AnyRecord = isObject(transformed) && isObject(transformed.error)
          ? transformed.error
          : {}
        const message = typeof upstreamError.message === "string" && upstreamError.message.trim()
          ? upstreamError.message.trim()
          : `上游返回 HTTP ${upstream.status} ${upstream.statusText}`
        const type = typeof upstreamError.type === "string" && upstreamError.type.trim()
          ? upstreamError.type.trim()
          : "upstream_error"
        return relayErrorResponse({
          target: params.target,
          stream: true,
          statusCode: upstream.status,
          message,
          type,
          code: upstreamError.code,
        })
      }
      return Response.json(transformed, {
        status: upstream.status,
        headers: {
          "x-codex-hot-switch-provider": params.target.provider.id,
          "x-codex-hot-switch-model": params.target.modelId,
          "x-codex-hot-switch-web-search-relay": "1",
        },
      })
    }

    const responsePayload = responseFromRelayPayload(payload, currentBuilt)
    const transformed = transformResponse(params.target, params.path, responsePayload, currentBuilt, {
      recordHistory: false,
    })
    const calls = extractRelayWebSearchCalls(transformed)
    if (calls.length === 0) {
      const response = mergeRelayOutputItems(transformed, relayedItems)
      return relayResponse({
        response,
        payload: responsePayload,
        statusCode: upstream.status,
        built: currentBuilt,
        startedAt: params.startedAt,
        rawBody: params.rawBody,
        target: params.target,
        stream: params.stream,
      })
    }

    const results = []
    for (const call of calls) {
      const input = relayInputFromCall(call.item, params.target)
      let result
      try {
        result = await executeRelayWebSearch(input, params.requestSignal)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        appendLogDetached(
          makeLog({
            startedAt: params.startedAt,
            body: params.rawBody,
            target: params.target,
            statusCode: 502,
            rewrittenBody: currentBuilt.rewrittenBody,
            responseSummary: `web_search 执行失败：${message}`,
            error: message,
            errorStack: error instanceof Error ? error.stack : undefined,
          }),
        )
        return relayErrorResponse({
          target: params.target,
          stream: params.stream,
          statusCode: 502,
          message,
        })
      }
      results.push({ callId: call.callId, output: result.text })
      relayedItems.push({
        ...call.item,
        status: "completed",
        call_id: call.callId,
        arguments: call.argumentsText,
        action: {
          type: "search",
          query: result.query,
          provider: result.provider,
        },
      })
    }
    currentBody = nextRelayBody(currentBody, transformed, calls, results)
  }

  const message = `web_search 连续调用超过 ${WEB_SEARCH_RELAY_MAX_TURNS} 轮，已停止`
  if (currentBuilt) {
    appendLogDetached(
      makeLog({
        startedAt: params.startedAt,
        body: params.rawBody,
        target: params.target,
        statusCode: 429,
        rewrittenBody: currentBuilt.rewrittenBody,
        responseSummary: message,
        error: message,
      }),
    )
  }
  return relayErrorResponse({
    target: params.target,
    stream: params.stream,
    statusCode: 429,
    message,
    type: "web_search_relay_error",
    code: "web_search_relay_max_turns",
  })
}

export async function handleProxyPost(parts: string[], request: Request) {
  const path = normalizePath(parts)
  if (!SUPPORTED_POST_PATHS.has(path)) {
    return Response.json(
      { error: `暂不支持的中转路径：/${path}` },
      { status: 404 },
    )
  }

  const startedAt = Date.now()
  let body: unknown
  let rawBody: unknown
  let target: ProxyTarget | undefined
  let built: BuiltRequest | undefined

  try {
    const imageApiRequest = isImagesApiPath(path)
      ? await parseImagesApiRequest(path, request)
      : null
    rawBody = imageApiRequest?.requestedBody ?? await readDecodedJsonRequest(request)
    body = filterPrivateParams(imageApiRequest?.body ?? rawBody).body
    const snapshot = await getRoutingSnapshot()
    target = resolveTarget(snapshot, body)
    target.fullRequestLoggingEnabled = snapshot.settings.fullRequestLoggingEnabled === true
    target = applyAuxiliaryRouting(snapshot, body, target)
    if (!target.provider.enabled) {
      throw new Error(`供应商「${target.provider.name}」已停用`)
    }
    const hasImageGenerationTool = containsImageGenerationTool(body)
    if (hasImageGenerationTool && !target.paused && !target.provider.rawResponsesPassthrough) {
      const imageTarget = resolveImageGenerationTarget(snapshot, target)
      target = imageTarget.target
      body = applyImageGenerationModel(body, imageTarget.imageModel.modelId).body
    }
    if (hasImageGenerationTool && !isOpenAIResponsesProtocol(target.provider.protocol)) {
      throw new Error(
        `当前目标供应商「${target.provider.name}」使用 ${target.provider.protocol} 协议，不能承载 OpenAI Responses 的 image_generation 工具；请切换到 OpenAI Responses 兼容供应商。`,
      )
    }

    body = sanitizeImagesForTargetModel(body, target.model, target.modelId).body
    const effectivePath = isImagesApiPath(path) ? "v1/responses" : path
    if (shouldStripHostedWebSearch(target, effectivePath, body, snapshot.settings.webSearchMode)) {
      body = stripHostedWebSearchTools(body)
    }
    if (shouldHandleCompactLocally(target, effectivePath)) {
      return await handleResponsesCompactFallback({
        body,
        rawBody: rawBody ?? body,
        target,
        startedAt,
        requestSignal: request.signal,
      })
    }
    if (shouldRelayWebSearch(target, effectivePath, body, snapshot.settings.webSearchMode)) {
      return await handleRelayWebSearchResponses({
        path: effectivePath,
        body,
        rawBody: rawBody ?? body,
        target,
        startedAt,
        stream: requestWantsStream(body),
        requestSignal: request.signal,
      })
    }

    built = buildProxyRequest(target, effectivePath, body)
    const retryTarget = target
    let capacityRetryCount = 0
    const fetchUpstream = async () => {
      const result = await fetchWithModelCapacityRetry({
        enabled:
          retryTarget.provider.rawResponsesPassthrough === true &&
          isOpenAIResponsesProtocol(retryTarget.provider.protocol) &&
          isResponsesPath(effectivePath) &&
          built?.adapter?.type === "passthrough",
        requestIsStream:
          requestWantsStream(body) || requestWantsStream(built?.rewrittenBody),
        requestSignal: request.signal,
        maxRetries: Math.max(0, MODEL_CAPACITY_MAX_RETRIES - capacityRetryCount),
        fetchResponse: () => fetchWithProviderTimeout(retryTarget, built!, request.signal),
      })
      capacityRetryCount += result.retryCount
      return result.response
    }
    let upstream = await fetchUpstream()
    const successResponse = await maybeHandleSuccessfulUpstream({
      imageApiRequest,
      upstream,
      built,
      startedAt,
      rawBody: rawBody ?? body,
      target,
      path,
      capacityRetryCount,
    })
    if (successResponse) return successResponse

    if (shouldDiagnoseOpenAIResponsesStreamFallthrough({
      target,
      path: effectivePath,
      body,
      built,
      upstream,
    })) {
      await writeQwenResponsesStreamFallthroughDiagnostic({
        target,
        startedAt,
        path: effectivePath,
        statusCode: upstream.status,
        upstream,
        rawBody: rawBody ?? body,
        rewrittenBody: built.rewrittenBody,
        adapter: built.adapter,
      }).catch(() => null)
    }

    let payload = await parseJsonSafe(upstream)
    const attemptedRectifiers = new Set<RectifierKind>()
    while (!upstream.ok) {
      const rectified = maybeRectifyUpstreamError({
        target,
        status: upstream.status,
        payload,
        rewrittenBody: built.rewrittenBody,
        attempted: attemptedRectifiers,
      })
      if (!rectified) break

      attemptedRectifiers.add(rectified.kind)
      built = withRewrittenBody(built, rectified.body)
      upstream = await fetchUpstream()
      const rectifiedSuccessResponse = await maybeHandleSuccessfulUpstream({
        imageApiRequest,
        upstream,
        built,
        startedAt,
        rawBody: rawBody ?? body,
        target,
        path,
        capacityRetryCount,
      })
      if (rectifiedSuccessResponse) return rectifiedSuccessResponse
      payload = await parseJsonSafe(upstream)
    }

    const rawResponsesPassthrough =
      upstream.ok &&
      target.provider.rawResponsesPassthrough &&
      isOpenAIResponsesProtocol(target.provider.protocol) &&
      isResponsesPath(path)
    const transformed = upstream.ok
      ? rawResponsesPassthrough
        ? withResponseModel(
            payload,
            built.adapter?.type === "passthrough"
              ? built.adapter.responseModelOverride || target.requestedModel
              : target.requestedModel,
          )
        : transformResponse(target, path, payload, built)
      : normalizeUpstreamErrorPayload(payload, upstream.status)
    if (upstream.ok && rawResponsesPassthrough) {
      recordCodexChatResponse(transformed, built.rewrittenBody)
    }

    const error =
      upstream.ok
        ? undefined
        : `上游返回 HTTP ${upstream.status} ${upstream.statusText}`
    appendLogDetached(
      makeLog({
        startedAt,
        body: rawBody,
        target,
        statusCode: upstream.status,
        rewrittenBody: built.rewrittenBody,
        responseSummary:
          capacityRetryCount > 0
            ? `模型容量重试 ${capacityRetryCount} 次；${compactJson(transformed)}`
            : compactJson(transformed),
        tokenUsage: extractTokenUsage(transformed) || extractTokenUsage(payload),
        error,
      }),
    )

    if (!upstream.ok && requestWantsStream(body)) {
      const upstreamError = transformed && typeof transformed === "object"
        ? (transformed as AnyRecord).error
        : undefined
      const errorObject = upstreamError && typeof upstreamError === "object"
        ? upstreamError as AnyRecord
        : {}
      const message = typeof errorObject.message === "string" && errorObject.message.trim()
        ? errorObject.message.trim()
        : `上游返回 HTTP ${upstream.status} ${upstream.statusText}`
      const type = typeof errorObject.type === "string" && errorObject.type.trim()
        ? errorObject.type.trim()
        : "upstream_error"
      return new Response(
        streamText(
          errorResponseSse({
            model: target.requestedModel || target.modelId,
            message,
            type,
            code: errorObject.code,
          }),
        ),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "x-codex-hot-switch-provider": target.provider.id,
            "x-codex-hot-switch-model": target.modelId,
            "x-codex-hot-switch-upstream-error": String(upstream.status),
            ...(capacityRetryCount > 0
              ? { "x-codex-hot-switch-capacity-retries": String(capacityRetryCount) }
              : {}),
          },
        },
      )
    }

    return Response.json(transformed, {
      status: upstream.status,
      headers: {
        "x-codex-hot-switch-provider": target.provider.id,
        "x-codex-hot-switch-model": target.modelId,
        ...(capacityRetryCount > 0
          ? { "x-codex-hot-switch-capacity-retries": String(capacityRetryCount) }
          : {}),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = error instanceof ProxyRequestBodyError ? error.status : 502
    const type = error instanceof ProxyRequestBodyError ? "invalid_request_error" : "server_error"
    const errorStack = error instanceof Error ? error.stack : undefined
    if (target) {
      appendLogDetached(
        makeLog({
          startedAt,
          body: rawBody ?? body,
          target,
          statusCode: status,
          rewrittenBody: built?.rewrittenBody,
          responseSummary: status === 502 ? "502 Bad Gateway" : message,
          error: message,
          errorStack,
        }),
      )
    } else {
      appendLogDetached(
        makeEarlyFailureLog({
          startedAt,
          path,
          request,
          body: rawBody ?? body,
          statusCode: status,
          responseSummary: status === 502 ? "502 Bad Gateway before target resolved" : message,
          error: message,
          errorStack,
        }),
      )
    }
    if (requestWantsStream(body)) {
      return new Response(
        streamText(errorResponseSse({ model: target?.requestedModel || target?.modelId || "codex", message, type })),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            "connection": "keep-alive",
            ...(target ? {
              "x-codex-hot-switch-provider": target.provider.id,
              "x-codex-hot-switch-model": target.modelId,
            } : {}),
            "x-codex-hot-switch-upstream-error": String(status),
          },
        },
      )
    }
    return Response.json({ error: { message, type } }, { status })
  }
}

function hasCodexClientVersionQuery(request: Request) {
  const url = new URL(request.url)
  return Array.from(url.searchParams.keys()).some(
    (key) => key.toLowerCase() === "client_version",
  )
}

function isCodexModelsRequest(parts: string[], request: Request) {
  return (
    parts[0]?.trim().toLowerCase() === "codex" ||
    hasCodexClientVersionQuery(request)
  )
}

export async function handleProxyGet(parts: string[], request: Request) {
  const wantsCodexModels = isCodexModelsRequest(parts, request)
  const path = normalizePath(parts)
  if (path !== "v1/models" && path !== "models") {
    return Response.json(
      { error: `暂不支持的中转路径：/${path}` },
      { status: 404 },
    )
  }

  const snapshot = await getRoutingSnapshot()
  if (wantsCodexModels) {
    return Response.json(buildCodexClientModelsResponse(snapshot))
  }

  return Response.json(buildOpenAIModelsResponse(snapshot))
}
