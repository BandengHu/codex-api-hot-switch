import "server-only"

import {
  htmlUpstreamErrorMessage,
  looksLikeHtmlDocument,
} from "./html-response-retry"

type AnyRecord = Record<string, any>

const ERROR_BODY_PREVIEW_LIMIT = 4000

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function truncatePreview(value: string) {
  return Array.from(value).slice(0, ERROR_BODY_PREVIEW_LIMIT).join("")
}

// Codex 客户端把 response.failed 的 error.code 声明成字符串
// （codex-rs/codex-api/src/sse/responses_error.rs 的 `code: Option<String>`）。
// 数字 code 会让整条 error 对象反序列化失败并被客户端整体丢弃，只剩
// "stream disconnected before completion: response.failed event received"，
// 上游的真实 message 一并消失。这里统一规范成字符串：数字业务码按十进制字符串
// 保留，语义与可读性都不变。
export function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

// 同一个结构体里 `type` 也是 Option<String>：type 非字符串会与数字 code 一样
// 让整条 error 反序列化失败。所有要交给 Codex 的 Responses 形状 error 都过这里。
export function normalizeResponsesErrorFields(error: AnyRecord): AnyRecord {
  const normalized: AnyRecord = { ...error }
  const code = normalizeErrorCode(error.code)
  if (code != null) normalized.code = code
  else delete normalized.code
  const type = normalizeErrorType(error.type)
  if (type != null) normalized.type = type
  else delete normalized.type
  return normalized
}

export function normalizeErrorType(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  // 上游把业务码塞进 type 时同样是数字（如 6004）；Codex 的 type 是 Option<String>，
  // 数字会让整条 error 反序列化失败，所以这里也统一字符串化。
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function nestedJsonObject(text: string) {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function pickErrorObject(payload: unknown): unknown {
  if (!isObject(payload)) return payload
  if (isObject(payload.error)) {
    const nestedMessage = safeTrim(payload.error.message)
    const nested = nestedMessage ? nestedJsonObject(nestedMessage) : undefined
    if (nested) return pickErrorObject(nested)
    return payload.error
  }
  if (isObject(payload.base_resp)) return payload.base_resp
  if (isObject(payload.baseResp)) return payload.baseResp
  return payload
}

function messageFromError(error: unknown, status: number) {
  if (typeof error === "string") {
    const message = error.trim()
    return looksLikeHtmlDocument(message) ? htmlUpstreamErrorMessage(status) : message
  }
  if (!isObject(error)) return ""
  const direct =
    safeTrim(error.message) ||
    safeTrim(error.msg) ||
    safeTrim(error.detail) ||
    safeTrim(error.error_description) ||
    safeTrim(error.error) ||
    safeTrim(error.status_msg) ||
    safeTrim(error.statusMessage)
  if (direct) return looksLikeHtmlDocument(direct) ? htmlUpstreamErrorMessage(status) : direct
  return truncatePreview(compactJson(error))
}

export function normalizeUpstreamErrorPayload(
  payload: unknown,
  status: number,
): { error: { message: string; type: string; code?: string | number; param?: string } } {
  const error = pickErrorObject(payload)
  const message =
    messageFromError(error, status) ||
    (payload == null ? "Upstream returned an empty error response" : `Upstream returned HTTP ${status}`)

  const type = isObject(error)
    ? safeTrim(error.type) || safeTrim(error.error_type) || "upstream_error"
    : "upstream_error"
  const code = isObject(error)
    ? normalizeErrorCode(error.code ?? error.status_code ?? error.statusCode)
    : undefined
  const param = isObject(error) ? safeTrim(error.param) || undefined : undefined

  return {
    error: {
      message: truncatePreview(message),
      type,
      ...(code != null ? { code } : {}),
      ...(param ? { param } : {}),
    },
  }
}
