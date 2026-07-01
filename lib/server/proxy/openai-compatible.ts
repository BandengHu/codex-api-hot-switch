import "server-only"

import {
  prepareCodexOpenAICompatibleRequest,
  type CodexAdapter,
} from "./codex-protocol"
import {
  joinUrl,
  providerHeaders,
  type ProxyTarget,
} from "./common"
import { appendOutputLanguagePolicyToResponsesBody } from "./language-policy"

export interface OpenAICompatibleBuiltRequest {
  url: string
  init: RequestInit
  rewrittenBody: unknown
  adapter: CodexAdapter
}

function joinOpenAICompatibleUrl(baseUrl: string, path: string) {
  const skipVersionPrefix = baseUrl.trim().endsWith("#")
  const normalizedBase = baseUrl.trim().replace(/#+$/, "").replace(/\/+$/, "")
  const normalizedPath = path.replace(/^\/+/, "")
  if (
    !skipVersionPrefix &&
    /(?:^|\/)(?:v\d+(?:beta)?|api\/v\d+)$/i.test(normalizedBase) &&
    normalizedPath.startsWith("v1/")
  ) {
    return joinUrl(normalizedBase, normalizedPath.slice(3))
  }
  return joinUrl(normalizedBase, normalizedPath)
}

function codexAdapterRequestsStream(adapter: CodexAdapter) {
  return adapter.type === "chat_completions"
    ? adapter.stream
    : adapter.requestIsStream
}

export function buildOpenAICompatibleRequest(
  target: ProxyTarget,
  path: string,
  body: unknown,
): OpenAICompatibleBuiltRequest {
  const prepared = prepareCodexOpenAICompatibleRequest(
    path,
    body,
    target.modelId,
    target.reasoning,
    {
      preserveRequestControls: target.paused,
      rawResponsesPassthrough: Boolean(target.provider.rawResponsesPassthrough),
    },
  )
  appendOutputLanguagePolicyToResponsesBody(prepared.body, target)

  return {
    url: joinOpenAICompatibleUrl(target.provider.baseUrl, prepared.upstreamPath),
    rewrittenBody: prepared.body,
    adapter: prepared.adapter,
    init: {
      method: "POST",
      headers: providerHeaders(target.provider, {
        accept: codexAdapterRequestsStream(prepared.adapter)
          ? "text/event-stream"
          : "application/json",
        "content-type": "application/json",
      }),
      body: JSON.stringify(prepared.body),
    },
  }
}
