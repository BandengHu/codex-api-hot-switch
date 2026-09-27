import "server-only"

import {
  availableProviderEndpoints,
  classifyEndpointFailure,
  endpointTargetProvider,
  EndpointAttemptError,
  recordProviderEndpointFailure,
  recordProviderEndpointSuccess,
} from "@/lib/server/provider-endpoint-runtime"
import type { ProxyTarget } from "./common"
import { fetchWithHtmlResponseRetry } from "./html-response-retry"
import { fetchWithModelCapacityRetry } from "./model-capacity-retry"
import {
  buildProxyRequest,
  fetchWithProviderTimeout,
  parseJsonSafe,
  type BuiltProxyRequest,
} from "./request-builder"
import { prepareUpstreamResponse } from "./upstream-response-primer"

export interface EndpointFailoverResult {
  target: ProxyTarget
  built: BuiltProxyRequest
  response: Response
  capacityRetryCount: number
  htmlRetryCount: number
}

function isClientCancellation(error: unknown, requestSignal?: AbortSignal) {
  if (requestSignal?.aborted) return true
  const message = error instanceof Error ? error.message : String(error)
  return /客户端已取消|client.*cancel|request.*cancel/i.test(message)
}

function syntheticFailureResponse(message: string, status = 502) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "upstream_error",
      },
    }),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  )
}

async function classifyResponse(response: Response) {
  const payload = await parseJsonSafe(response.clone())
  return {
    payload,
    classification: classifyEndpointFailure({
      status: response.status,
      payload,
      text: typeof payload === "string" ? payload : "",
    }),
  }
}

function isSuccessfulHtmlResponse(response: Response) {
  if (!response.ok) return false
  const contentType = response.headers.get("content-type")?.toLowerCase() || ""
  return (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml")
  )
}

export async function fetchWithEndpointFailover(params: {
  target: ProxyTarget
  path: string
  body: unknown
  requestSignal?: AbortSignal
  requestIsStream: boolean
  capacityRetryEnabled: boolean
}): Promise<EndpointFailoverResult> {
  const rootProvider = params.target.provider
  const endpoints = await availableProviderEndpoints(rootProvider)
  if (endpoints.length === 0) {
    return {
      target: {
        ...params.target,
        attemptedEndpointIds: [],
        failoverReason: "没有可用端点",
      },
      built: buildProxyRequest(params.target, params.path, params.body),
      response: syntheticFailureResponse(
        "供应商没有可用的 URL/API Key 端点",
        503,
      ),
      capacityRetryCount: 0,
      htmlRetryCount: 0,
    }
  }

  const attemptedEndpointIds: string[] = []
  const failoverReasons: string[] = []
  let capacityRetryCount = 0
  let htmlRetryCount = 0
  let lastTarget = params.target
  let lastBuilt: BuiltProxyRequest | undefined
  let lastFailureMessage = "上游端点失败"
  let lastFailureStatus = 502

  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index]
    attemptedEndpointIds.push(endpoint.id)
    const target: ProxyTarget = {
      ...params.target,
      provider: endpointTargetProvider(rootProvider, endpoint),
      attemptedEndpointIds: [...attemptedEndpointIds],
      ...(failoverReasons.length > 0
        ? { failoverReason: failoverReasons.join("；") }
        : {}),
    }
    lastTarget = target
    const built = buildProxyRequest(target, params.path, params.body)
    lastBuilt = built

    try {
      const htmlResult = await fetchWithHtmlResponseRetry({
        requestSignal: params.requestSignal,
        fetchResponse: async () => {
          const capacityResult = await fetchWithModelCapacityRetry({
            enabled: params.capacityRetryEnabled,
            requestIsStream: params.requestIsStream,
            requestSignal: params.requestSignal,
            fetchResponse: () =>
              fetchWithProviderTimeout(target, built, params.requestSignal),
          })
          capacityRetryCount += capacityResult.retryCount
          return capacityResult.response
        },
      })
      htmlRetryCount += htmlResult.retryCount
      let response = htmlResult.response

      if (isSuccessfulHtmlResponse(response)) {
        const text = await response.clone().text()
        const classification = classifyEndpointFailure({
          status: 502,
          text: `上游返回 HTML 错误页：${text.slice(0, 500)}`,
        })
        lastFailureMessage = classification.message
        lastFailureStatus = 502
        const result = await recordProviderEndpointFailure(
          rootProvider,
          endpoint,
          classification,
        )
        if (!result.shouldFailover || index === endpoints.length - 1) {
          return {
            target,
            built,
            response: syntheticFailureResponse(classification.message),
            capacityRetryCount,
            htmlRetryCount,
          }
        }
        failoverReasons.push(`${endpoint.name}：${classification.message}`)
        continue
      }

      if (response.ok) {
        response = await prepareUpstreamResponse(response, params.requestIsStream, {
          requestSignal: params.requestSignal,
          timeoutMs: target.provider.timeoutMs,
        })
      }

      if (response.ok) {
        await recordProviderEndpointSuccess(rootProvider, endpoint)
        return {
          target,
          built,
          response,
          capacityRetryCount,
          htmlRetryCount,
        }
      }

      const { classification } = await classifyResponse(response)
      lastFailureMessage = classification.message
      lastFailureStatus = classification.status || response.status
      if (classification.kind === "terminal") {
        return {
          target,
          built,
          response,
          capacityRetryCount,
          htmlRetryCount,
        }
      }

      const result = await recordProviderEndpointFailure(
        rootProvider,
        endpoint,
        classification,
      )
      if (!result.shouldFailover || index === endpoints.length - 1) {
        return {
          target,
          built,
          response,
          capacityRetryCount,
          htmlRetryCount,
        }
      }
      failoverReasons.push(`${endpoint.name}：${classification.message}`)
    } catch (error) {
      if (isClientCancellation(error, params.requestSignal)) throw error
      const classification =
        error instanceof EndpointAttemptError
          ? error
          : classifyEndpointFailure({ error })
      lastFailureMessage = classification.message
      lastFailureStatus = classification.status || 502
      const result = await recordProviderEndpointFailure(
        rootProvider,
        endpoint,
        classification,
      )
      if (!result.shouldFailover || index === endpoints.length - 1) {
        return {
          target,
          built,
          response: syntheticFailureResponse(
            classification.message,
            lastFailureStatus,
          ),
          capacityRetryCount,
          htmlRetryCount,
        }
      }
      failoverReasons.push(`${endpoint.name}：${classification.message}`)
    }
  }

  return {
    target: {
      ...lastTarget,
      attemptedEndpointIds: [...attemptedEndpointIds],
      failoverReason:
        failoverReasons.length > 0
          ? failoverReasons.join("；")
          : lastFailureMessage,
    },
    built: lastBuilt || buildProxyRequest(params.target, params.path, params.body),
    response: syntheticFailureResponse(lastFailureMessage, lastFailureStatus),
    capacityRetryCount,
    htmlRetryCount,
  }
}
