export const MAX_PROXY_BODY_BYTES = 128 * 1024 * 1024

export class ProxyBodyTooLargeError extends Error {
  readonly limit: number
  readonly observedBytes?: number

  constructor(label: string, limit: number, observedBytes?: number) {
    const observed =
      observedBytes == null ? "" : `（已检测到至少 ${observedBytes} 字节）`
    super(`${label}超过大小上限 ${limit} 字节${observed}`)
    this.name = "ProxyBodyTooLargeError"
    this.limit = limit
    this.observedBytes = observedBytes
  }
}

function declaredContentLength(headers: Headers) {
  const raw = headers.get("content-length")?.trim()
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export async function readBodyBytesWithLimit(
  body: ReadableStream<Uint8Array> | null,
  options: {
    headers?: Headers
    label: string
    maxBytes?: number
  },
) {
  const maxBytes = Math.max(0, options.maxBytes ?? MAX_PROXY_BODY_BYTES)
  const declaredBytes = options.headers
    ? declaredContentLength(options.headers)
    : undefined
  if (declaredBytes != null && declaredBytes > maxBytes) {
    throw new ProxyBodyTooLargeError(options.label, maxBytes, declaredBytes)
  }
  if (!body) return new Uint8Array()

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (!next.value || next.value.byteLength === 0) continue
      totalBytes += next.value.byteLength
      if (totalBytes > maxBytes) {
        const error = new ProxyBodyTooLargeError(
          options.label,
          maxBytes,
          totalBytes,
        )
        await reader.cancel(error).catch(() => undefined)
        throw error
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }

  if (chunks.length === 0) return new Uint8Array()
  if (chunks.length === 1) return chunks[0]

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function readRequestBytesWithLimit(
  request: Request,
  maxBytes = MAX_PROXY_BODY_BYTES,
) {
  return readBodyBytesWithLimit(request.body, {
    headers: request.headers,
    label: "请求体",
    maxBytes,
  })
}

export function readResponseBytesWithLimit(
  response: Response,
  maxBytes = MAX_PROXY_BODY_BYTES,
) {
  return readBodyBytesWithLimit(response.body, {
    headers: response.headers,
    label: "上游响应体",
    maxBytes,
  })
}
