export const HTML_RESPONSE_MAX_RETRIES = 2

type FetchResponse = () => Promise<Response>

export interface HtmlResponseRetryResult {
  response: Response
  retryCount: number
}

function contentTypeLooksLikeHtml(response: Response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() || ""
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml")
}

export function looksLikeHtmlDocument(text: string) {
  const normalized = text.trimStart().toLowerCase()
  return (
    normalized.startsWith("<!doctype html") ||
    normalized.startsWith("<html") ||
    (normalized.includes("<html") && normalized.includes("</html>"))
  )
}

export function htmlUpstreamErrorMessage(status: number) {
  const label =
    status === 502
      ? "Bad Gateway"
      : status === 503
        ? "Service Unavailable"
        : status === 504
          ? "Gateway Timeout"
          : ""
  return `上游返回 HTTP ${status}${label ? ` ${label}` : ""}（HTML 错误页）`
}

async function isHtmlErrorResponse(response: Response) {
  if (response.ok) return false
  if (contentTypeLooksLikeHtml(response)) return true

  try {
    const text = await response.clone().text()
    return looksLikeHtmlDocument(text)
  } catch {
    return false
  }
}

export async function fetchWithHtmlResponseRetry(params: {
  fetchResponse: FetchResponse
  requestSignal?: AbortSignal
  maxRetries?: number
}): Promise<HtmlResponseRetryResult> {
  const maxRetries = Math.max(0, params.maxRetries ?? HTML_RESPONSE_MAX_RETRIES)
  let retryCount = 0

  while (true) {
    const response = await params.fetchResponse()
    if (
      !(await isHtmlErrorResponse(response)) ||
      retryCount >= maxRetries ||
      params.requestSignal?.aborted
    ) {
      return { response, retryCount }
    }

    try {
      await response.body?.cancel("retrying HTML upstream error")
    } catch {
      // The upstream may already have closed the error response.
    }
    retryCount += 1
  }
}
