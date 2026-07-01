import "server-only"

import { isChatModel, isImageGenerationModel } from "@/lib/model-capabilities"
import type { RoutingSnapshot } from "@/lib/types"
import type { ProxyTarget } from "./common"

type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isImageGenerationTool(value: unknown) {
  return isObject(value) && value.type === "image_generation"
}

export function containsImageGenerationTool(body: unknown) {
  return (
    isObject(body) &&
    Array.isArray(body.tools) &&
    body.tools.some(isImageGenerationTool)
  )
}

export function applyImageGenerationModel<T>(
  body: T,
  imageModelId: string,
): { body: T; updated: boolean } {
  const model = imageModelId.trim()
  if (!model || !isObject(body) || !Array.isArray(body.tools)) {
    return { body, updated: false }
  }

  let updated = false
  const tools = body.tools.map((tool) => {
    if (!isImageGenerationTool(tool)) return tool
    if (tool.model === model) return tool
    updated = true
    return { ...tool, model }
  })

  return updated ? { body: { ...body, tools } as T, updated } : { body, updated }
}

export function resolveImageGenerationTarget(
  snapshot: RoutingSnapshot,
  currentTarget: ProxyTarget,
) {
  const provider = snapshot.providers.find(
    (item) => item.id === snapshot.settings.imageGenerationProviderId,
  )
  if (!provider) throw new Error("专用生图供应商不存在")
  if (provider.protocol !== "openai-responses") {
    throw new Error(
      `专用生图供应商「${provider.name}」使用 ${provider.protocol} 协议，不能承载 OpenAI Responses 的 image_generation 工具。`,
    )
  }
  if (!provider.enabled) throw new Error(`专用生图供应商「${provider.name}」已停用`)

  const imageModel = snapshot.models.find(
    (item) =>
      item.id === snapshot.settings.imageGenerationModelId &&
      item.providerId === provider.id &&
      item.enabled &&
      isImageGenerationModel(item),
  )
  if (!imageModel) throw new Error("专用生图模型不存在或未启用")

  const currentModel =
    currentTarget.provider.id === provider.id &&
    currentTarget.model &&
    currentTarget.model.enabled &&
    isChatModel(currentTarget.model)
      ? currentTarget.model
      : undefined
  const defaultModel = snapshot.models.find(
    (item) =>
      item.id === snapshot.settings.defaultModelId &&
      item.providerId === provider.id &&
      item.enabled &&
      isChatModel(item),
  )
  const fallbackModel = snapshot.models.find(
    (item) => item.providerId === provider.id && item.enabled && isChatModel(item),
  )
  const chatModel = currentModel || defaultModel || fallbackModel
  if (!chatModel) {
    throw new Error(
      `专用生图供应商「${provider.name}」缺少可用聊天模型，无法承载 Responses 生图请求。`,
    )
  }

  return {
    target: {
      ...currentTarget,
      provider,
      model: chatModel,
      modelId: chatModel.modelId,
      reasoning: chatModel.supportsReasoning ? currentTarget.reasoning : "off",
    },
    imageModel,
  }
}
