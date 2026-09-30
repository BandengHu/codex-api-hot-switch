import "server-only"

import { getSystemProxyDispatcher } from "../proxy/system-proxy"

type WebRequestInput = string | URL | Request
type WebFetchInit = RequestInit & { dispatcher?: unknown }

export function webRequestUrl(input: WebRequestInput): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return input.url
}

export function buildWebFetchInit(
  init: RequestInit | undefined,
  dispatcher: unknown,
): WebFetchInit {
  if (!dispatcher) return { ...(init ?? {}) }
  return {
    ...(init ?? {}),
    dispatcher,
  }
}

export async function fetchWeb(
  input: WebRequestInput,
  init?: RequestInit,
): Promise<Response> {
  const dispatcher = getSystemProxyDispatcher(webRequestUrl(input))
  return fetch(input, buildWebFetchInit(init, dispatcher) as RequestInit)
}
