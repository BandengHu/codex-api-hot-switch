import "server-only"

export function chatCompletionsErrorResponse(params: {
  status: number
  message: string
  type: string
  code?: unknown
  headers?: HeadersInit
}) {
  return Response.json(
    {
      error: {
        message: params.message,
        type: params.type,
        ...(params.code != null ? { code: params.code } : {}),
      },
    },
    {
      status: params.status,
      headers: params.headers,
    },
  )
}
