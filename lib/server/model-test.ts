import "server-only"

import { isChatModel } from "@/lib/model-capabilities"
import type { Model, ModelTestResult, Provider, ReasoningEffort } from "@/lib/types"
import {
  buildProxyRequest,
  extractTextSummary,
  extractUsageSummary,
  fetchWithProviderTimeout,
  parseJsonSafe,
} from "./proxy/request-builder"
import type { ProxyTarget as RelayProxyTarget } from "./proxy/common"

function testBody(modelId: string, reasoning: ReasoningEffort) {
  return {
    model: modelId,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Reply with exactly: OK",
          },
        ],
      },
    ],
    max_output_tokens: 16,
    stream: false,
    ...(reasoning === "off" ? {} : { reasoning: { effort: reasoning } }),
  }
}

export async function runModelTest(params: {
  provider: Provider
  model: Model
  reasoning?: ReasoningEffort
}): Promise<ModelTestResult> {
  const { provider, model } = params
  const started = Date.now()
  const duration = () => Date.now() - started

  if (!provider.enabled) {
    return {
      ok: false,
      message: "供应商已停用，未发起模型测试",
      durationMs: duration(),
      providerId: provider.id,
      modelId: model.id,
    }
  }
  if (!model.enabled) {
    return {
      ok: false,
      message: "模型已停用，未发起模型测试",
      durationMs: duration(),
      providerId: provider.id,
      modelId: model.id,
    }
  }
  if (model.providerId !== provider.id) {
    return {
      ok: false,
      message: "模型与供应商不匹配",
      durationMs: duration(),
      providerId: provider.id,
      modelId: model.id,
    }
  }
  if (!isChatModel(model)) {
    return {
      ok: false,
      message: "当前测试按钮只支持 chat 模型",
      durationMs: duration(),
      providerId: provider.id,
      modelId: model.id,
    }
  }

  const reasoning = model.supportsReasoning ? params.reasoning || "off" : "off"
  const body = testBody(model.modelId, reasoning)
  const target: RelayProxyTarget = {
    provider,
    model,
    modelId: model.modelId,
    requestedModel: model.modelId,
    reasoning,
    paused: false,
  }

  try {
    const built = buildProxyRequest(target, "v1/responses", body)
    const response = await fetchWithProviderTimeout(target, built)
    const payload = await parseJsonSafe(response)
    const outputText = extractTextSummary(payload)
    const tokenUsage = extractUsageSummary(payload)
    const detail = !response.ok
      ? typeof payload === "string"
        ? payload.slice(0, 240)
        : JSON.stringify(payload).slice(0, 240)
      : outputText

    return {
      ok: response.ok,
      message: response.ok
        ? `模型测试通过，耗时 ${duration()}ms${outputText ? `，返回：${outputText}` : ""}`
        : `模型测试失败：HTTP ${response.status} ${response.statusText}${detail ? `：${detail}` : ""}`,
      durationMs: duration(),
      providerId: provider.id,
      modelId: model.id,
      statusCode: response.status,
      outputText,
      tokenUsage,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `模型测试失败：${message}`,
      durationMs: duration(),
      providerId: provider.id,
      modelId: model.id,
    }
  }
}
