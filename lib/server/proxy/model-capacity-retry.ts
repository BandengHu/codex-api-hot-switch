export const MODEL_CAPACITY_MAX_RETRIES = 2
const MAX_STREAM_INSPECTION_BYTES = 256 * 1024

type AnyRecord = Record<string, unknown>

export interface ModelCapacityRetryResult {
  response: Response
  retryCount: number
  lastCapacityMessage?: string
}

interface CapacityInspection {
  response: Response
  capacityMessage?: string
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function isModelCapacityMessage(value: unknown) {
  const text = String(value || "").trim().toLowerCase()
  return (
    text.includes("selected model is at capacity") ||
    text.includes("model is at capacity")
  )
}

function errorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (!isObject(value)) return ""
  for (const key of ["message", "detail", "error"]) {
    const nested = errorMessage(value[key])
    if (nested) return nested
  }
  return ""
}

function capacityMessageFromPayload(value: unknown, allowHttpError: boolean) {
  if (!isObject(value)) return undefined
  const response = isObject(value.response) ? value.response : value
  const type = String(value.type || response.type || "").trim().toLowerCase()
  const status = String(response.status || "").trim().toLowerCase()
  const failed = type === "response.failed" || status === "failed"
  if (!failed && !allowHttpError) return undefined

  const message = errorMessage(response.error) || errorMessage(value.error)
  return isModelCapacityMessage(message) ? message : undefined
}

function capacityFailureFromJson(text: string, allowHttpError: boolean) {
  try {
    return capacityMessageFromPayload(JSON.parse(text), allowHttpError)
  } catch {
    return allowHttpError && isModelCapacityMessage(text)
      ? "Selected model is at capacity. Please try a different model."
      : undefined
  }
}

function sseData(frame: string) {
  const data = []
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  return data.join("\n").trim()
}

function capacityFailureFromSse(text: string) {
  let searchFrom = 0
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const frameIndex = text.indexOf(frame, searchFrom)
    searchFrom = frameIndex + frame.length
    const payload = sseData(frame)
    if (!payload || payload === "[DONE]") continue
    const message = capacityFailureFromJson(payload, false)
    if (message) return { index: Math.max(0, frameIndex), message }
  }
  return undefined
}

function hasCompleteResponseFailedFrame(text: string) {
  const frames = text.split(/\r?\n\r?\n/)
  if (frames.length <= 1) return false
  for (const frame of frames.slice(0, -1)) {
    const payload = sseData(frame)
    if (!payload || payload === "[DONE]") continue
    try {
      const value = JSON.parse(payload)
      if (!isObject(value)) continue
      const response = isObject(value.response) ? value.response : value
      const type = String(value.type || response.type || "").trim().toLowerCase()
      const status = String(response.status || "").trim().toLowerCase()
      if (type === "response.failed" || status === "failed") return true
    } catch {
      // Keep buffering malformed or incomplete frames.
    }
  }
  return false
}

function firstCommittedOutputIndex(text: string) {
  const match = /"type"\s*:\s*"response\.(?:completed|done|output_item\.(?:added|done)|content_part\.(?:added|done)|output_text\.(?:delta|done)|reasoning(?:_summary)?_text\.(?:delta|done)|function_call_arguments\.(?:delta|done)|web_search_call\.[^"]+|image_generation_call\.[^"]+)"/i.exec(
    text,
  )
  return match?.index ?? -1
}

function responseWithReplayBody(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  bufferedChunks: Uint8Array[],
) {
  let bufferedIndex = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (bufferedIndex < bufferedChunks.length) {
        controller.enqueue(bufferedChunks[bufferedIndex])
        bufferedIndex += 1
        return
      }
      try {
        const { value, done } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        if (value) controller.enqueue(value)
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
    headers: response.headers,
  })
}

async function inspectEventStream(response: Response): Promise<CapacityInspection> {
  if (!response.body) return { response }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let inspectedText = ""
  let inspectedBytes = 0

  while (inspectedBytes < MAX_STREAM_INSPECTION_BYTES) {
    const { value, done } = await reader.read()
    if (done) {
      inspectedText += decoder.decode()
      break
    }
    if (!value?.length) continue

    chunks.push(value)
    inspectedBytes += value.byteLength
    inspectedText += decoder.decode(value, { stream: true })

    const capacity = capacityFailureFromSse(inspectedText)
    const committedIndex = firstCommittedOutputIndex(inspectedText)
    if (capacity && (committedIndex < 0 || capacity.index < committedIndex)) {
      return {
        response: responseWithReplayBody(response, reader, chunks),
        capacityMessage: capacity.message,
      }
    }
    if (committedIndex >= 0 || hasCompleteResponseFailedFrame(inspectedText)) {
      break
    }
  }

  const capacity = capacityFailureFromSse(inspectedText)
  const committedIndex = firstCommittedOutputIndex(inspectedText)
  if (capacity && (committedIndex < 0 || capacity.index < committedIndex)) {
    return {
      response: responseWithReplayBody(response, reader, chunks),
      capacityMessage: capacity.message,
    }
  }

  return {
    response: responseWithReplayBody(response, reader, chunks),
  }
}

async function inspectCapacityFailure(
  response: Response,
  requestIsStream: boolean,
): Promise<CapacityInspection> {
  const contentType = response.headers.get("content-type")?.toLowerCase() || ""
  if (requestIsStream && response.ok && contentType.includes("text/event-stream")) {
    return inspectEventStream(response)
  }

  try {
    const text = await response.clone().text()
    return {
      response,
      capacityMessage: capacityFailureFromJson(text, !response.ok),
    }
  } catch {
    return { response }
  }
}

async function discardResponse(response: Response) {
  try {
    await response.body?.cancel("retrying model capacity failure")
  } catch {
    // The upstream may already have closed the failed response stream.
  }
}

export async function fetchWithModelCapacityRetry(params: {
  enabled: boolean
  requestIsStream: boolean
  requestSignal?: AbortSignal
  fetchResponse: () => Promise<Response>
  maxRetries?: number
}): Promise<ModelCapacityRetryResult> {
  const maxRetries = Math.max(
    0,
    Math.min(MODEL_CAPACITY_MAX_RETRIES, params.maxRetries ?? MODEL_CAPACITY_MAX_RETRIES),
  )
  let retryCount = 0
  let lastCapacityMessage: string | undefined

  while (true) {
    const upstream = await params.fetchResponse()
    if (!params.enabled) {
      return { response: upstream, retryCount }
    }

    const inspected = await inspectCapacityFailure(upstream, params.requestIsStream)
    if (!inspected.capacityMessage) {
      return {
        response: inspected.response,
        retryCount,
        lastCapacityMessage,
      }
    }

    lastCapacityMessage = inspected.capacityMessage
    if (retryCount >= maxRetries || params.requestSignal?.aborted) {
      return {
        response: inspected.response,
        retryCount,
        lastCapacityMessage,
      }
    }

    await discardResponse(inspected.response)
    retryCount += 1
  }
}
