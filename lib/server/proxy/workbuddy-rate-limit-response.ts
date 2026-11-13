import "server-only"

import { chatCompletionsErrorResponse } from "./chat-completions-error"
import { isChatCompletionsPath } from "./common"

export function workbuddyRateLimitClientResponse(params: {
  path: string
  status: number
  message: string
  headers?: HeadersInit
}) {
  if (!isChatCompletionsPath(params.path)) return null
  return chatCompletionsErrorResponse({
    status: params.status,
    message: params.message,
    type: "rate_limit_error",
    headers: params.headers,
  })
}
