import "server-only"

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

function numberOrString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return value
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
  if (typeof error === "string") return error.trim()
  if (!isObject(error)) return ""
  const direct =
    safeTrim(error.message) ||
    safeTrim(error.detail) ||
    safeTrim(error.error_description) ||
    safeTrim(error.error) ||
    safeTrim(error.status_msg) ||
    safeTrim(error.statusMessage)
  if (direct) return direct
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
    ? numberOrString(error.code ?? error.status_code ?? error.statusCode)
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
