/**
 * 对齐 cc-switch #6495/#7458 与 #6c9d444：Codex 的 view_image 等工具会把
 * `detail: "original"` 的图片塞进 function_call_output，如果直接塞进 Chat
 * 的 tool 文本里，会被 base64 化（~9000x token 膨胀）并触发严格网关 400。
 *
 * 处理方式和 cc-switch 一致：
 * - 从工具输出里剥离媒体块，替换成占位文本；
 * - 图片的 `detail: "original"` 降级为 `"auto"`；
 * - 剥离出来的媒体块合并成一条 synthetic user 消息，跟在 tool 结果后面。
 */

type AnyRecord = Record<string, any>

export const TOOL_RESULT_MEDIA_MOVED_MARKER =
  "[cc-switch: tool result media moved to the following user message]"
export const TOOL_RESULT_MEDIA_ATTACHED_MARKER =
  "[cc-switch: tool result media attached as native media]"

const WHOLE_DATA_URL_MIN_BYTES = 8 * 1024
const BASE64ISH_MIN_BYTES = 16 * 1024
const MAX_MEDIA_TRAVERSAL_DEPTH = 32

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function canonicalJson(value: unknown): string {
  if (value == null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function isImageMimeType(value: string) {
  return value.slice(0, 6).toLowerCase() === "image/"
}

function isImageBase64DataUrl(value: string) {
  const comma = value.indexOf(",")
  if (comma < 0) return false
  const header = value.slice(0, comma).toLowerCase()
  return header.startsWith("data:image/") && header.endsWith(";base64")
}

function looksLikeBase64Payload(value: string) {
  if (value.length < BASE64ISH_MIN_BYTES) return false
  return /^[A-Za-z0-9+/=]+$/.test(value)
}

function wholeStringImageDataUrl(value: string): AnyRecord | undefined {
  const trimmed = value.trim()
  if (trimmed.length < WHOLE_DATA_URL_MIN_BYTES || !isImageBase64DataUrl(trimmed)) {
    return undefined
  }
  return {
    type: "image_url",
    image_url: { url: trimmed },
  }
}

function mergeTopLevelDetail(part: AnyRecord, imageUrl: AnyRecord) {
  if (imageUrl.detail == null && part.detail != null) {
    imageUrl.detail = part.detail
  }
  // 对齐 cc-switch #7476：OpenAI 兼容 Chat 网关只接受 auto / low / high，
  // Codex 的 original 会被严格网关整个 400。降级而不是原样透传。
  if (imageUrl.detail === "original") {
    imageUrl.detail = "auto"
  }
}

function normalizedImageUrl(part: AnyRecord): AnyRecord | undefined {
  const raw = part.image_url
  let imageUrl: AnyRecord | undefined
  if (typeof raw === "string" && raw.trim()) {
    imageUrl = { url: raw.trim() }
  } else if (isObject(raw) && typeof raw.url === "string" && raw.url.trim()) {
    imageUrl = { ...raw }
  }
  if (!imageUrl) return undefined
  mergeTopLevelDetail(part, imageUrl)
  return imageUrl
}

function looseDataImageUrl(part: AnyRecord): AnyRecord | undefined {
  if (part.type != null) return undefined
  const imageUrl = normalizedImageUrl(part)
  if (!imageUrl?.url?.toLowerCase().startsWith("data:")) return undefined
  return imageUrl
}

function typedImageHasPayload(part: AnyRecord): boolean {
  const source = part.source
  if (isObject(source)) {
    if (!isImageMimeType(String(source.media_type || source.mime_type || source.mimeType || ""))) {
      return false
    }
    if (typeof source.url === "string" && source.url.trim()) return true
    if (typeof source.data === "string" && source.data.trim()) return true
    return false
  }
  return (
    typeof part.data === "string" &&
    part.data.trim() !== "" &&
    isImageMimeType(String(part.mimeType || part.mime_type || ""))
  )
}

function typedImageUrl(part: AnyRecord): AnyRecord | undefined {
  const source = part.source
  if (isObject(source)) {
    if (!isImageMimeType(String(source.media_type || source.mime_type || source.mimeType || ""))) {
      return undefined
    }
    if (typeof source.url === "string" && source.url.trim()) {
      const imageUrl: AnyRecord = { url: source.url.trim() }
      mergeTopLevelDetail(part, imageUrl)
      return imageUrl
    }
    if (typeof source.data === "string" && source.data.trim()) {
      const mediaType = String(source.media_type || source.mime_type || source.mimeType || "image/png")
      const url = source.data.slice(0, 11).toLowerCase() === "data:image/"
        ? source.data
        : `data:${mediaType};base64,${source.data}`
      const imageUrl: AnyRecord = { url }
      mergeTopLevelDetail(part, imageUrl)
      return imageUrl
    }
    return undefined
  }
  const data = typeof part.data === "string" ? part.data.trim() : ""
  if (!data) return undefined
  const mediaType = String(part.mimeType || part.mime_type || "")
  if (!isImageMimeType(mediaType)) return undefined
  const imageUrl: AnyRecord = { url: `data:${mediaType};base64,${data}` }
  mergeTopLevelDetail(part, imageUrl)
  return imageUrl
}

function imageUrlContentPart(imageUrl: AnyRecord): AnyRecord {
  return { type: "image_url", image_url: imageUrl }
}

type ToolMediaKind = "image" | "file" | "audio"

function toolMediaKind(part: AnyRecord): ToolMediaKind | undefined {
  const type = part.type
  if (type === "input_image" || type === "image_url") {
    return normalizedImageUrl(part) ? "image" : undefined
  }
  if (type === "input_file") {
    return part.file_id != null || part.file_data != null ? "file" : undefined
  }
  if (type === "input_audio") {
    return isObject(part.input_audio) ? "audio" : undefined
  }
  if (type === "image") {
    return typedImageHasPayload(part) ? "image" : undefined
  }
  if (type == null) {
    return looseDataImageUrl(part) ? "image" : undefined
  }
  return undefined
}

function chatImagePart(part: AnyRecord): AnyRecord | undefined {
  const type = part.type
  if (type === "input_image" || type === "image_url") {
    const imageUrl = normalizedImageUrl(part)
    return imageUrl ? imageUrlContentPart(imageUrl) : undefined
  }
  if (type === "image") {
    const imageUrl = typedImageUrl(part)
    return imageUrl ? imageUrlContentPart(imageUrl) : undefined
  }
  if (type == null) {
    const imageUrl = looseDataImageUrl(part)
    return imageUrl ? imageUrlContentPart(imageUrl) : undefined
  }
  return undefined
}

function chatFileFromInputFile(part: AnyRecord): AnyRecord | undefined {
  if (part.file_id == null && part.file_data == null) return undefined
  const file: AnyRecord = {}
  for (const key of ["file_id", "file_data", "filename"]) {
    if (part[key] != null) file[key] = part[key]
  }
  return file
}

function chatMediaPartFromToolPart(part: AnyRecord): AnyRecord | undefined {
  const kind = toolMediaKind(part)
  if (!kind) return undefined
  if (kind === "image") return chatImagePart(part)
  if (kind === "file") {
    const file = chatFileFromInputFile(part)
    return file ? { type: "file", file } : undefined
  }
  if (kind === "audio") {
    return { type: "input_audio", input_audio: part.input_audio }
  }
  return undefined
}

function clampBase64ishStrings(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim()
    const shouldOmit =
      (trimmed.length >= WHOLE_DATA_URL_MIN_BYTES &&
        trimmed.slice(0, 5).toLowerCase() === "data:") ||
      looksLikeBase64Payload(trimmed)
    if (shouldOmit) {
      return `[cc-switch: omitted ${value.length} bytes]`
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map(clampBase64ishStrings)
  }
  if (isObject(value)) {
    const out: AnyRecord = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = clampBase64ishStrings(child)
    }
    return out
  }
  return value
}

function stripMediaFromToolValueAtDepth(
  value: unknown,
  mediaParts: AnyRecord[],
  replacementBlock: AnyRecord,
  replacementText: string,
  depth: number,
): { value: unknown; replaced: number } {
  if (depth > MAX_MEDIA_TRAVERSAL_DEPTH) return { value, replaced: 0 }

  if (typeof value === "string") {
    const mediaPart = wholeStringImageDataUrl(value)
    if (mediaPart) {
      mediaParts.push(mediaPart)
      return { value: replacementText, replaced: 1 }
    }
    const trimmed = value.trim()
    if (!trimmed) return { value, replaced: 0 }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return { value, replaced: 0 }
    }
    const result = stripMediaFromToolValueAtDepth(
      parsed,
      mediaParts,
      replacementBlock,
      replacementText,
      depth + 1,
    )
    if (result.replaced === 0) return { value, replaced: 0 }
    const clamped = clampBase64ishStrings(result.value)
    return { value: canonicalJson(clamped), replaced: result.replaced }
  }

  if (Array.isArray(value)) {
    let replaced = 0
    const next = value.map((item) => {
      const result = stripMediaFromToolValueAtDepth(
        item,
        mediaParts,
        replacementBlock,
        replacementText,
        depth + 1,
      )
      replaced += result.replaced
      return result.value
    })
    return { value: next, replaced }
  }

  if (isObject(value)) {
    const mediaPart = chatMediaPartFromToolPart(value)
    if (mediaPart) {
      mediaParts.push(mediaPart)
      return { value: replacementBlock, replaced: 1 }
    }
    if (value.content != null) {
      const result = stripMediaFromToolValueAtDepth(
        value.content,
        mediaParts,
        replacementBlock,
        replacementText,
        depth + 1,
      )
      if (result.replaced > 0) {
        return { value: { ...value, content: result.value }, replaced: result.replaced }
      }
    }
    return { value, replaced: 0 }
  }

  return { value, replaced: 0 }
}

export interface ChatToolOutputMediaPlan {
  toolContent: string
  mediaParts: AnyRecord[]
  outputValue: unknown
}

export function planChatToolOutputMedia(
  output: unknown,
  replacementText = TOOL_RESULT_MEDIA_MOVED_MARKER,
): ChatToolOutputMediaPlan | undefined {
  const outputWasString = typeof output === "string"
  const replacementBlock = { type: "text", text: replacementText }
  const mediaParts: AnyRecord[] = []
  const result = stripMediaFromToolValueAtDepth(
    output,
    mediaParts,
    replacementBlock,
    replacementText,
    0,
  )
  if (result.replaced === 0) return undefined
  const clamped = clampBase64ishStrings(result.value)
  return {
    toolContent: outputWasString && typeof clamped === "string"
      ? clamped
      : canonicalJson(clamped),
    mediaParts,
    outputValue: clamped,
  }
}
