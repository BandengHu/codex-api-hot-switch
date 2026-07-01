import "server-only"

import type { Model } from "@/lib/types"

type AnyRecord = Record<string, any>

export const UNSUPPORTED_IMAGE_MARKER = "[Unsupported Image]"

const TEXT_ONLY_MODEL_TAILS = new Set([
  "ark-code-latest",
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.1",
  "kat-coder",
  "kat-coder-pro",
  "kat-coder-pro v1",
  "kat-coder-pro v2",
  "kat-coder-pro-v1",
  "kat-coder-pro-v2",
  "ling-2.5-1t",
  "longcat-flash-chat",
  "mimo-v2.5-pro",
  "us.deepseek.r1-v1",
])

const TEXT_ONLY_MODEL_TAIL_PREFIXES = [
  "minimax-m2.7",
  "qwen3-coder",
  "step-3.5-flash",
]

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function normalizeModelId(value: string) {
  return value.trim().replace(/^models\//i, "").trim().toLowerCase()
}

function modelTail(modelId: string) {
  const normalized = normalizeModelId(modelId)
  return normalized.split("/").at(-1) || normalized
}

function knownTextOnlyModel(modelId: string) {
  const tail = modelTail(modelId)
  return (
    TEXT_ONLY_MODEL_TAILS.has(tail) ||
    TEXT_ONLY_MODEL_TAIL_PREFIXES.some((prefix) => tail.startsWith(prefix))
  )
}

function isImageBlockType(type: unknown) {
  return type === "image" || type === "image_url" || type === "input_image"
}

function contentHasImageBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    if (!isObject(block)) return false
    return isImageBlockType(block.type) || contentHasImageBlocks(block.content)
  })
}

export function containsImageBlocks(body: unknown): boolean {
  if (!isObject(body)) return false
  if (
    Array.isArray(body.messages) &&
    body.messages.some((message) => isObject(message) && contentHasImageBlocks(message.content))
  ) {
    return true
  }
  return responsesInputHasImageBlocks(body.input)
}

function responsesInputHasImageBlocks(input: unknown): boolean {
  if (Array.isArray(input)) return input.some(responsesInputItemHasImageBlocks)
  return responsesInputItemHasImageBlocks(input)
}

function responsesInputItemHasImageBlocks(item: unknown): boolean {
  if (!isObject(item)) return false
  return item.type === "input_image" || contentHasImageBlocks(item.content)
}

function replaceImageBlockWithMarker(block: AnyRecord, textType: "text" | "input_text") {
  const cacheControl = block.cache_control
  for (const key of Object.keys(block)) delete block[key]
  block.type = textType
  block.text = UNSUPPORTED_IMAGE_MARKER
  if (cacheControl != null) block.cache_control = cacheControl
}

function replaceImagesInContent(
  content: unknown,
  textType: "text" | "input_text",
): number {
  if (!Array.isArray(content)) return 0
  let replaced = 0
  for (const block of content) {
    if (!isObject(block)) continue
    if (isImageBlockType(block.type)) {
      replaceImageBlockWithMarker(block, textType)
      replaced += 1
      continue
    }
    replaced += replaceImagesInContent(block.content, textType)
  }
  return replaced
}

function replaceImagesInResponsesInput(input: unknown): number {
  if (Array.isArray(input)) return input.map(replaceImagesInResponsesInputItem).reduce((a, b) => a + b, 0)
  return replaceImagesInResponsesInputItem(input)
}

function replaceImagesInResponsesInputItem(item: unknown): number {
  if (!isObject(item)) return 0
  let replaced = 0
  if (item.type === "input_image") {
    replaceImageBlockWithMarker(item, "input_text")
    replaced += 1
  }
  return replaced + replaceImagesInContent(item.content, "input_text")
}

function replaceImagesInBody(body: unknown) {
  if (!isObject(body)) return 0
  const messageCount = Array.isArray(body.messages)
    ? body.messages
        .map((message) => (isObject(message) ? replaceImagesInContent(message.content, "text") : 0))
        .reduce((a, b) => a + b, 0)
    : 0
  return messageCount + replaceImagesInResponsesInput(body.input)
}

export function replaceImageBlocksWithMarker(body: unknown) {
  return replaceImagesInBody(body)
}

export function sanitizeImagesForTargetModel<T>(
  body: T,
  model: Model | undefined,
  modelId: string,
): { body: T; replacedImages: number } {
  if (!containsImageBlocks(body)) return { body, replacedImages: 0 }
  if (model?.supportsVision === true) return { body, replacedImages: 0 }

  const shouldReplace =
    model?.supportsVision === false ||
    knownTextOnlyModel(model?.modelId || modelId)

  return {
    body,
    replacedImages: shouldReplace ? replaceImagesInBody(body) : 0,
  }
}
