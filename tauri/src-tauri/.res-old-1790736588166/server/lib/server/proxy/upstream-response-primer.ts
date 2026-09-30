import "server-only"

import {
  classifyEndpointFailure,
  EndpointAttemptError,
  type EndpointFailureClassification,
} from "@/lib/server/provider-endpoint-runtime"
import { readResponseBytesWithLimit } from "./body-size-limit"

type AnyRecord = Record<string, unknown>

const MAX_STREAM_PRIME_BYTES = 256 * 1024

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function numericHttpStatus(...values: unknown[]) {
  for (const value of values) {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d{3}$/.test(value.trim())
          ? Number(value.trim())
          : Number.NaN
    if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed
  }
  return undefined
}

function semanticFailureClassification(params: {
  payload: unknown
  event?: string
  text?: string
}): (EndpointFailureClassification & { payload: unknown }) | null {
  if (!isObject(params.payload)) return null

  const envelope = params.payload
  const response = isObject(envelope.response) ? envelope.response : envelope
  const error =
    response.error != null
      ? response.error
      : envelope.error != null
        ? envelope.error
        : undefined
  const errorRecord = isObject(error) ? error : {}
  const event = firstString(params.event, envelope.type, response.type).toLowerCase()
  const responseStatus = firstString(response.status).toLowerCase()
  const hasError = error !== undefined && error !== null
  const failed =
    event === "response.failed" ||
    event === "error" ||
    responseStatus === "failed" ||
    responseStatus === "cancelled" ||
    hasError
  if (!failed) return null

  const errorType = firstString(
    errorRecord.type,
    errorRecord.code,
    envelope.code,
    responseStatus,
    event,
    "upstream_error",
  )
  const message = firstString(
    errorRecord.message,
    errorRecord.detail,
    response.message,
    envelope.message,
    typeof error === "string" ? error : "",
    responseStatus === "cancelled"
      ? "response generation was cancelled"
      : "response generation failed",
  )
  const diagnostic = `${event} ${responseStatus} ${errorType} ${message} ${params.text || ""}`
  const embeddedStatus = numericHttpStatus(
    errorRecord.status,
    errorRecord.status_code,
    errorRecord.http_status,
    errorRecord.code,
    response.status_code,
    response.http_status,
    envelope.status_code,
    envelope.http_status,
  )
  const authenticationFailure =
    /(authentication[_ -]?error|unauthoriz|invalid[_ -]?api[_ -]?key|api key[^ ]* invalid)/i.test(
      diagnostic,
    )
  const permissionFailure = /permission[_ -]?denied|forbidden/i.test(diagnostic)
  const clientFailure =
    /(invalid[_ -]?(request|argument|parameter)|bad[_ -]?request|validation[_ -]?error|unprocessable|unsupported|not[_ -]?supported|model[_ -]?not[_ -]?found|no available channel for model|context[_ -]?length|maximum context|too many tokens|malformed)/i.test(
      diagnostic,
    )
  const rateLimitFailure = /rate[_ -]?limit|too many requests/i.test(diagnostic)
  const unavailableFailure =
    /(overloaded|server[_ -]?error|internal[_ -]?error|service[_ -]?unavailable|temporarily[_ -]?unavailable)/i.test(
      diagnostic,
    )

  let classification: EndpointFailureClassification
  if (authenticationFailure) {
    classification = { kind: "auth", message, status: embeddedStatus || 401 }
  } else if (permissionFailure) {
    classification = { kind: "terminal", message, status: embeddedStatus || 403 }
  } else {
    classification = classifyEndpointFailure({
      status: embeddedStatus,
      payload: params.payload,
      text: diagnostic,
    })
  }
  if (classification.kind === "terminal" && !clientFailure && !permissionFailure) {
    classification = {
      kind: "transient",
      message: classification.message,
      status:
        embeddedStatus ||
        (rateLimitFailure ? 429 : unavailableFailure ? 503 : 502),
    }
  }

  const status =
    embeddedStatus ||
    classification.status ||
    (classification.kind === "quota"
      ? 429
      : classification.kind === "auth"
        ? 401
      : classification.kind === "transient"
          ? rateLimitFailure
            ? 429
            : unavailableFailure
              ? 503
              : 502
          : permissionFailure
            ? 403
            : 400)

  return {
    ...classification,
    message: `上游在首个有效输出前返回 ${errorType}: ${message}`,
    status,
    payload: params.payload,
  }
}

function parseSseFrame(raw: string) {
  let event = ""
  const dataLines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart())
  }
  const dataText = dataLines.join("\n")
  if (!dataText || dataText === "[DONE]") {
    return { event, dataText, payload: undefined as unknown }
  }
  try {
    return { event, dataText, payload: JSON.parse(dataText) as unknown }
  } catch {
    return { event, dataText, payload: undefined as unknown }
  }
}

function frameIsSemantic(frame: ReturnType<typeof parseSseFrame>) {
  const failure = semanticFailureClassification({
    payload: frame.payload,
    event: frame.event,
    text: frame.dataText,
  })
  if (failure) throw new EndpointAttemptError(failure)

  const payload = isObject(frame.payload) ? frame.payload : {}
  const type = firstString(frame.event, payload.type).toLowerCase()
  if (
    type === "response.completed" ||
    type === "response.done" ||
    type === "message_stop"
  ) {
    return true
  }
  if (type === "response.output_item.added") {
    const item = isObject(payload.item) ? payload.item : {}
    const itemType = firstString(item.type).toLowerCase()
    if (
      itemType.includes("function_call") ||
      itemType.includes("tool") ||
      itemType.includes("image_generation")
    ) {
      return true
    }
  }
  if (type === "content_block_start") {
    const block = isObject(payload.content_block) ? payload.content_block : {}
    const blockType = firstString(block.type).toLowerCase()
    return (
      blockType === "tool_use" ||
      (typeof block.text === "string" && block.text.length > 0) ||
      (typeof block.thinking === "string" && block.thinking.length > 0)
    )
  }
  if (type.includes("delta")) {
    if (typeof payload.delta === "string" && payload.delta.length > 0) {
      return true
    }
    const delta = isObject(payload.delta) ? payload.delta : {}
    if (
      (typeof delta.text === "string" && delta.text.length > 0) ||
      (typeof delta.thinking === "string" && delta.thinking.length > 0) ||
      (typeof delta.partial_json === "string" && delta.partial_json.length > 0) ||
      Array.isArray(delta.tool_calls) ||
      Boolean(delta.function_call)
    ) {
      return true
    }
  }
  if (Array.isArray(payload.choices)) {
    return payload.choices.some((choice) => {
      if (!isObject(choice) || !isObject(choice.delta)) return false
      const delta = choice.delta
      return Boolean(
        delta.content ||
        delta.reasoning_content ||
        delta.tool_calls ||
        delta.function_call,
      )
    })
  }
  if (Array.isArray(payload.candidates)) {
    return payload.candidates.some((candidate) => {
      if (!isObject(candidate) || !isObject(candidate.content)) return false
      const parts = candidate.content.parts
      if (!Array.isArray(parts)) return false
      return parts.some((part) => {
        if (!isObject(part)) return false
        return (
          (typeof part.text === "string" && part.text.length > 0) ||
          Boolean(part.functionCall) ||
          Boolean(part.function_call)
        )
      })
    })
  }
  if (
    type === "ping" ||
    type === "response.created" ||
    type === "response.queued" ||
    type.endsWith(".created") ||
    type.endsWith(".in_progress")
  ) {
    return false
  }
  return false
}

function splitSseFrame(buffer: string) {
  const lf = buffer.indexOf("\n\n")
  const crlf = buffer.indexOf("\r\n\r\n")
  if (lf < 0 && crlf < 0) return null
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    return { index: crlf, separatorLength: 4 }
  }
  return { index: lf, separatorLength: 2 }
}

function inspectJsonDocument(text: string) {
  const trimmed = text.trim()
  if (!trimmed || !["{", "["].includes(trimmed[0])) return false
  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return false
  }
  const failure = semanticFailureClassification({ payload, text: trimmed })
  if (failure) throw new EndpointAttemptError(failure)
  return true
}

function replayResponse(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: Uint8Array[],
) {
  let bufferedIndex = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bufferedIndex < buffered.length) {
        controller.enqueue(buffered[bufferedIndex])
        bufferedIndex += 1
        return
      }
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          return
        }
        if (next.value) controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  })
}

async function prepareBufferedResponse(response: Response) {
  if (!response.body) return response
  try {
    const body = await readResponseBytesWithLimit(response)
    const text = new TextDecoder().decode(body)
    if (text.trim()) inspectJsonDocument(text)
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  } catch (error) {
    if (error instanceof EndpointAttemptError) throw error
    throw new EndpointAttemptError({
      ...classifyEndpointFailure({ error }),
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function prepareUpstreamResponse(
  response: Response,
  requestIsStream: boolean,
  options: {
    requestSignal?: AbortSignal
    timeoutMs?: number
  } = {},
): Promise<Response> {
  if (!response.ok) return response
  if (!requestIsStream) return prepareBufferedResponse(response)
  if (!response.body) {
    throw new EndpointAttemptError({
      kind: "transient",
      status: 502,
      message: "上游流在首个有效输出前结束：响应体为空",
    })
  }

  const reader = response.body.getReader()
  const buffered: Uint8Array[] = []
  const decoder = new TextDecoder()
  let frameBuffer = ""
  let inspectedText = ""
  let inspectedBytes = 0
  let semantic = false
  let controlError: Error | undefined
  const timeoutMs = Math.max(0, options.timeoutMs || 0)
  const cancelReader = (reason: string) => {
    void reader.cancel(reason).catch(() => undefined)
  }
  const onClientAbort = () => {
    controlError = new Error("客户端已取消请求，上游请求已中止")
    cancelReader("client request cancelled")
  }
  if (options.requestSignal?.aborted) {
    onClientAbort()
  } else {
    options.requestSignal?.addEventListener("abort", onClientAbort, { once: true })
  }
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        controlError = new EndpointAttemptError({
          kind: "transient",
          status: 504,
          message: `上游流在首个有效输出前超时：超过 ${timeoutMs}ms 未收到有效事件`,
        })
        cancelReader("upstream first semantic event timeout")
      }, timeoutMs)
    : undefined

  try {
    while (!semantic) {
      const next = await reader.read()
      if (controlError) throw controlError
      if (next.done) {
        const tail = decoder.decode()
        if (tail) {
          frameBuffer += tail
          inspectedText += tail
        }
        if (inspectJsonDocument(inspectedText)) {
          semantic = true
          break
        }
        let boundary = splitSseFrame(frameBuffer)
        while (boundary) {
          const rawFrame = frameBuffer.slice(0, boundary.index)
          frameBuffer = frameBuffer.slice(boundary.index + boundary.separatorLength)
          if (frameIsSemantic(parseSseFrame(rawFrame))) {
            semantic = true
            break
          }
          boundary = splitSseFrame(frameBuffer)
        }
        if (!semantic && frameBuffer.trim()) {
          semantic = frameIsSemantic(parseSseFrame(frameBuffer.trim()))
        }
        if (!semantic) {
          throw new EndpointAttemptError({
            kind: "transient",
            status: 502,
            message: "上游流在首个有效输出前结束：空流或缺少有效终止事件",
          })
        }
        break
      }
      if (!next.value?.length) continue

      buffered.push(next.value)
      inspectedBytes += next.value.byteLength
      const text = decoder.decode(next.value, { stream: true })
      inspectedText += text
      frameBuffer += text

      if (inspectJsonDocument(inspectedText)) {
        semantic = true
        break
      }

      let boundary = splitSseFrame(frameBuffer)
      while (boundary) {
        const rawFrame = frameBuffer.slice(0, boundary.index)
        frameBuffer = frameBuffer.slice(boundary.index + boundary.separatorLength)
        if (frameIsSemantic(parseSseFrame(rawFrame))) {
          semantic = true
          break
        }
        boundary = splitSseFrame(frameBuffer)
      }

      if (!semantic && inspectedBytes >= MAX_STREAM_PRIME_BYTES) {
        semantic = true
      }
    }
  } catch (error) {
    if (controlError) throw controlError
    try {
      await reader.cancel(error)
    } catch {
      // The upstream may already have closed the stream.
    }
    if (error instanceof EndpointAttemptError) throw error
    throw new EndpointAttemptError({
      ...classifyEndpointFailure({ error }),
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (timeout) clearTimeout(timeout)
    options.requestSignal?.removeEventListener("abort", onClientAbort)
  }

  return replayResponse(response, reader, buffered)
}
