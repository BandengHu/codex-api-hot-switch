import "server-only"

import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib"
import {
  MAX_PROXY_BODY_BYTES,
  ProxyBodyTooLargeError,
  readRequestBytesWithLimit,
  readResponseBytesWithLimit,
} from "./body-size-limit"

const JSON_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true })
const ENTITY_HEADERS = ["content-encoding", "content-length", "transfer-encoding"]

export class ProxyRequestBodyError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = "ProxyRequestBodyError"
    this.status = status
  }
}

function splitCodings(contentEncoding: string) {
  return contentEncoding
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding && coding !== "identity")
}

function isSingleSupportedCoding(coding: string) {
  return ["gzip", "x-gzip", "deflate", "br", "zstd", "zst"].includes(coding)
}

export function getContentEncoding(headers: Headers) {
  const combined = headers
    .get("content-encoding")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ")
    .toLowerCase()

  if (!combined || splitCodings(combined).length === 0) return null
  return combined
}

export function isSupportedContentEncoding(contentEncoding: string) {
  const codings = splitCodings(contentEncoding)
  return codings.length > 0 && codings.every(isSingleSupportedCoding)
}

function isOutputLimitError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const record = error as { code?: unknown; message?: unknown }
  return (
    record.code === "ERR_BUFFER_TOO_LARGE" ||
    (typeof record.message === "string" &&
      record.message.toLowerCase().includes("maxoutputlength"))
  )
}

function decompressWithLimit(
  coding: string,
  maxOutputBytes: number,
  decompress: () => Uint8Array,
) {
  try {
    const output = decompress()
    if (output.byteLength > maxOutputBytes) {
      throw new ProxyBodyTooLargeError(
        `${coding} 解压输出`,
        maxOutputBytes,
        output.byteLength,
      )
    }
    return output
  } catch (error) {
    if (error instanceof ProxyBodyTooLargeError) throw error
    if (isOutputLimitError(error)) {
      throw new ProxyBodyTooLargeError(`${coding} 解压输出`, maxOutputBytes)
    }
    throw error
  }
}

function decompressSingle(
  coding: string,
  body: Uint8Array,
  maxOutputBytes: number,
) {
  const options = { maxOutputLength: maxOutputBytes }
  switch (coding) {
    case "gzip":
    case "x-gzip":
      return decompressWithLimit(coding, maxOutputBytes, () =>
        gunzipSync(body, options),
      )
    case "deflate":
      try {
        return decompressWithLimit(coding, maxOutputBytes, () =>
          inflateSync(body, options),
        )
      } catch (error) {
        if (error instanceof ProxyBodyTooLargeError) throw error
        return decompressWithLimit(coding, maxOutputBytes, () =>
          inflateRawSync(body, options),
        )
      }
    case "br":
      return decompressWithLimit(coding, maxOutputBytes, () =>
        brotliDecompressSync(body, options),
      )
    case "zstd":
    case "zst":
      return decompressWithLimit(coding, maxOutputBytes, () =>
        zstdDecompressSync(body, options),
      )
    default:
      return null
  }
}

export function decompressRequestBody(
  contentEncoding: string,
  body: Uint8Array,
  maxOutputBytes = MAX_PROXY_BODY_BYTES,
) {
  const codings = splitCodings(contentEncoding)
  if (codings.length === 0) return null
  if (!codings.every(isSingleSupportedCoding)) return null

  let current = body
  for (const coding of codings.toReversed()) {
    const decompressed = decompressSingle(coding, current, maxOutputBytes)
    if (!decompressed) return null
    current = decompressed
  }
  return current
}

export async function readDecodedRequestBytes(request: Request) {
  try {
    const raw = await readRequestBytesWithLimit(request)
    const encoding = getContentEncoding(request.headers)
    if (!encoding) return raw

    if (!isSupportedContentEncoding(encoding)) {
      throw new ProxyRequestBodyError(`不支持的请求 content-encoding：${encoding}`, 415)
    }

    const decoded = decompressRequestBody(
      encoding,
      raw,
      MAX_PROXY_BODY_BYTES,
    )
    if (!decoded) {
      throw new ProxyRequestBodyError(`不支持的请求 content-encoding：${encoding}`, 415)
    }
    return decoded
  } catch (error) {
    if (error instanceof ProxyRequestBodyError) throw error
    if (error instanceof ProxyBodyTooLargeError) {
      throw new ProxyRequestBodyError(error.message, 413)
    }
    const encoding = getContentEncoding(request.headers)
    const message = error instanceof Error ? error.message : String(error)
    throw new ProxyRequestBodyError(
      encoding ? `请求体解压失败（${encoding}）：${message}` : message,
      400,
    )
  }
}

function includesZstdCoding(contentEncoding: string) {
  return splitCodings(contentEncoding).some((coding) => coding === "zstd" || coding === "zst")
}

function startsWithZstdFrame(body: Uint8Array) {
  return (
    body.length >= 4 &&
    body[0] === 0x28 &&
    body[1] === 0xb5 &&
    body[2] === 0x2f &&
    body[3] === 0xfd
  )
}

export async function readDecodedResponseText(response: Response) {
  const raw = await readResponseBytesWithLimit(response)
  if (raw.length === 0) return ""

  const encoding = getContentEncoding(response.headers)
  if (encoding && includesZstdCoding(encoding) && startsWithZstdFrame(raw)) {
    const decoded = decompressRequestBody(
      encoding,
      raw,
      MAX_PROXY_BODY_BYTES,
    )
    if (decoded) return JSON_TEXT_DECODER.decode(decoded)
  }

  try {
    return JSON_TEXT_DECODER.decode(raw)
  } catch (error) {
    if (!encoding || !isSupportedContentEncoding(encoding)) throw error
    const decoded = decompressRequestBody(
      encoding,
      raw,
      MAX_PROXY_BODY_BYTES,
    )
    if (!decoded) throw error
    return JSON_TEXT_DECODER.decode(decoded)
  }
}

export async function readDecodedJsonRequest(request: Request) {
  const bytes = await readDecodedRequestBytes(request)
  if (bytes.length === 0) return null

  let text: string
  try {
    text = JSON_TEXT_DECODER.decode(bytes)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ProxyRequestBodyError(`请求体不是有效的 UTF-8 JSON：${message}`, 400)
  }

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ProxyRequestBodyError(`请求体不是有效的 JSON：${message}`, 400)
  }
}

export async function readDecodedFormDataRequest(request: Request) {
  const bytes = await readDecodedRequestBytes(request)
  const headers = new Headers(request.headers)
  for (const header of ENTITY_HEADERS) headers.delete(header)
  return new Request(request.url, {
    method: request.method,
    headers,
    body: bytes,
  }).formData()
}
