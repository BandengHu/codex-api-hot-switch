import type { Model } from "@/lib/types"

export const MODEL_CAPABILITY_OPTIONS = [
  {
    value: "chat",
    label: "对话",
    description: "可作为 Codex 热切换/默认模型",
  },
  {
    value: "reasoning",
    label: "推理",
    description: "模型支持思考或 reasoning 参数",
  },
  {
    value: "vision",
    label: "视觉",
    description: "可接收图片输入",
  },
  {
    value: "tools",
    label: "工具",
    description: "支持工具调用或函数调用",
  },
  {
    value: "image_generation",
    label: "生图",
    description: "可作为 image_generation 专用模型",
  },
] as const

export type ModelCapability = (typeof MODEL_CAPABILITY_OPTIONS)[number]["value"]

export function modelHasCapability(model: Model, capability: string) {
  return model.capabilities.includes(capability)
}

export function normalizeModelCapabilities(capabilities: string[]) {
  const allowed = new Set<string>(MODEL_CAPABILITY_OPTIONS.map((item) => item.value))
  const normalized = Array.from(
    new Set(
      capabilities
        .map((capability) => capability.trim())
        .filter((capability) => allowed.has(capability)),
    ),
  )
  return normalized.length ? normalized : ["chat"]
}

export function isChatModel(model: Model) {
  return modelHasCapability(model, "chat")
}

export function isImageGenerationModel(model: Model) {
  return modelHasCapability(model, "image_generation")
}
