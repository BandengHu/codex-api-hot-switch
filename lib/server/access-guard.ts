import "server-only"

import { readSessionCookie, verifyApiKey } from "./access-auth"

function bearerToken(header: string | null) {
  if (!header) return ""
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || ""
}

export function apiKeyFromHeaders(headers: Pick<Headers, "get">) {
  return (
    headers.get("x-api-key")?.trim() ||
    bearerToken(headers.get("authorization"))
  )
}

export async function isApiKeyAuthorizedHeaders(headers: Pick<Headers, "get">) {
  const apiKey = apiKeyFromHeaders(headers)
  return Boolean(apiKey && (await verifyApiKey(apiKey)))
}

/**
 * API 调用只接受 API Key，不接受网页登录 Cookie。
 *
 * 这样网页登录只用于控制台/设置，不会改变 Codex 客户端和 MCP 的调用方式。
 */
export async function isApiKeyAuthorized(request: Request): Promise<boolean> {
  return isApiKeyAuthorizedHeaders(request.headers)
}

/**
 * 控制台/设置接口：API Key 或网页登录 Cookie 任一通过即可。
 */
export async function isAuthorized(request: Request): Promise<boolean> {
  if (await isApiKeyAuthorized(request)) return true
  return Boolean(await readSessionCookie(request.headers.get("cookie")))
}

export function apiKeyRequiredResponse() {
  return Response.json(
    {
      error: {
        message: "需要有效的 SwitchGate API Key",
        type: "authentication_error",
      },
    },
    {
      status: 401,
      headers: {
        "www-authenticate": 'Bearer realm="switchgate"',
        "cache-control": "no-store",
      },
    },
  )
}

export function authRequiredResponse() {
  return Response.json(
    {
      error: {
        message: "需要有效的 SwitchGate API Key 或网页登录会话",
        type: "authentication_error",
      },
    },
    {
      status: 401,
      headers: {
        "www-authenticate": 'Bearer realm="switchgate"',
        "cache-control": "no-store",
      },
    },
  )
}

