import type { WebToolError } from "./types"

export class WebSearchError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly provider: string
  readonly status?: number

  constructor(
    message: string,
    options: {
      code: string
      retryable: boolean
      provider: string
      status?: number
      cause?: unknown
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "WebSearchError"
    this.code = options.code
    this.retryable = options.retryable
    this.provider = options.provider
    this.status = options.status
  }

  toJSON(): WebToolError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      provider: this.provider,
      ...(this.status === undefined ? {} : { status: this.status }),
    }
  }
}

export function webToolError(error: unknown, provider = "switchgate"): WebToolError {
  if (error instanceof WebSearchError) return error.toJSON()
  const message = error instanceof Error ? error.message : String(error)
  return {
    code: "WEB_PROVIDER_ERROR",
    message,
    retryable: true,
    provider,
  }
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WebSearchError("网页搜索已取消", {
      code: "WEB_ABORTED",
      retryable: false,
      provider: "switchgate",
    })
  }
}

export function classifyHttpError(
  provider: string,
  status: number,
  body: string,
): WebSearchError {
  const lower = body.toLowerCase()
  const quota = status === 402 || status === 429 ||
    /rate.?limit|quota|余额|额度|too many requests|capacity/.test(lower)
  const auth = status === 401 || status === 403
  return new WebSearchError(
    `${provider} 搜索上游返回 HTTP ${status}${body.trim() ? `: ${body.trim().slice(0, 300)}` : ""}`,
    {
      code: quota ? "WEB_PROVIDER_QUOTA" : auth ? "WEB_PROVIDER_AUTH" : "WEB_PROVIDER_HTTP",
      retryable: quota || status >= 500,
      provider,
      status,
    },
  )
}
