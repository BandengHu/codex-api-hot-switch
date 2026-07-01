import "server-only"

type AnyRecord = Record<string, any>

const IMAGE_OUTPUT_DEFAULT_FORMAT = "b64_json"

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function isImagesGenerationsPath(path: string) {
  const normalized = path.replace(/^\/+/, "").split("?")[0]
  return /(^|\/)images\/generations$/.test(normalized)
}

export function isImagesEditsPath(path: string) {
  const normalized = path.replace(/^\/+/, "").split("?")[0]
  return /(^|\/)images\/edits$/.test(normalized)
}

export function isImagesApiPath(path: string) {
  return isImagesGenerationsPath(path) || isImagesEditsPath(path)
}

function normalizeResponseFormat(value: unknown) {
  const format = safeTrim(value || IMAGE_OUTPUT_DEFAULT_FORMAT).toLowerCase()
  return format === "url" ? "url" : IMAGE_OUTPUT_DEFAULT_FORMAT
}

function imageToolFromSource(source: AnyRecord, includeEditFields: boolean) {
  const tool: AnyRecord = {
    type: "image_generation",
    output_format: "png",
  }
  for (const key of ["quality", "background", "output_format", "moderation", "size"]) {
    const value = safeTrim(source[key])
    if (value) tool[key] = value
  }
  if (includeEditFields) {
    const fidelity = safeTrim(source.input_fidelity)
    if (fidelity) tool.input_fidelity = fidelity
  }
  for (const key of ["output_compression", "partial_images"]) {
    if (source[key] == null) continue
    const value = Number(source[key])
    if (Number.isFinite(value)) tool[key] = value
  }
  return tool
}

function imageInputContent(prompt: string, images: string[]) {
  return [
    { type: "input_text", text: prompt },
    ...images.map((imageUrl) => ({ type: "input_image", image_url: imageUrl })),
  ]
}

function buildResponsesBody(params: {
  prompt: string
  images: string[]
  tool: AnyRecord
  stream: boolean
}) {
  return {
    model: "image_generation_main",
    stream: params.stream,
    store: false,
    parallel_tool_calls: true,
    tool_choice: { type: "image_generation" },
    input: [
      {
        type: "message",
        role: "user",
        content: imageInputContent(params.prompt, params.images),
      },
    ],
    tools: [params.tool],
  }
}

function extractJsonEditImages(body: AnyRecord) {
  const images: string[] = []
  const single = safeTrim(body.image)
  if (single) images.push(single)
  if (Array.isArray(body.images)) {
    for (const item of body.images) {
      if (typeof item === "string" && item.trim()) {
        images.push(item.trim())
      } else if (isObject(item)) {
        const url = safeTrim(item.image_url || item.url)
        if (url) images.push(url)
      }
    }
  }
  return images
}

export function buildImagesGenerationResponsesBody(body: unknown) {
  if (!isObject(body)) throw new Error("images/generations 请求体必须是 JSON 对象")
  const prompt = safeTrim(body.prompt)
  if (!prompt) throw new Error("images/generations 请求缺少 prompt")
  const stream = Boolean(body.stream)
  return {
    body: buildResponsesBody({
      prompt,
      images: [],
      stream,
      tool: imageToolFromSource(body, false),
    }),
    requestedBody: body,
    responseFormat: normalizeResponseFormat(body.response_format),
    stream,
  }
}

export function buildImagesEditResponsesBodyFromJson(body: unknown) {
  if (!isObject(body)) throw new Error("images/edits 请求体必须是 JSON 对象")
  const prompt = safeTrim(body.prompt)
  if (!prompt) throw new Error("images/edits 请求缺少 prompt")
  const images = extractJsonEditImages(body)
  if (images.length === 0) {
    throw new Error("images/edits 请求缺少 image 或 images[].image_url")
  }
  const tool = imageToolFromSource(body, true)
  const maskUrl = safeTrim(body.mask?.image_url || body.mask)
  if (maskUrl) tool.input_image_mask = { image_url: maskUrl }
  const stream = Boolean(body.stream)
  return {
    body: buildResponsesBody({ prompt, images, stream, tool }),
    requestedBody: body,
    responseFormat: normalizeResponseFormat(body.response_format),
    stream,
  }
}

function fileToDataUrl(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const mimeType = file.type || "application/octet-stream"
    const base64 = Buffer.from(buffer).toString("base64")
    return `data:${mimeType};base64,${base64}`
  })
}

function firstString(formData: FormData, key: string) {
  const value = formData.get(key)
  return typeof value === "string" ? value.trim() : ""
}

function firstNumber(formData: FormData, key: string) {
  const value = Number(firstString(formData, key))
  return Number.isFinite(value) ? value : undefined
}

export async function buildImagesEditResponsesBodyFromFormData(formData: FormData) {
  const prompt = firstString(formData, "prompt")
  if (!prompt) throw new Error("images/edits 请求缺少 prompt")

  const files = [
    ...formData.getAll("image"),
    ...formData.getAll("image[]"),
  ].filter((value): value is File => value instanceof File)
  if (files.length === 0) throw new Error("images/edits 请求缺少 image")

  const images = await Promise.all(files.map(fileToDataUrl))
  const source: AnyRecord = {}
  for (const key of [
    "quality",
    "background",
    "output_format",
    "moderation",
    "size",
    "input_fidelity",
  ]) {
    const value = firstString(formData, key)
    if (value) source[key] = value
  }
  for (const key of ["output_compression", "partial_images"]) {
    const value = firstNumber(formData, key)
    if (value != null) source[key] = value
  }
  const tool = imageToolFromSource(source, true)
  const mask = formData.get("mask")
  if (mask instanceof File) {
    tool.input_image_mask = { image_url: await fileToDataUrl(mask) }
  }

  const stream = ["1", "true", "yes", "on"].includes(
    firstString(formData, "stream").toLowerCase(),
  )
  return {
    body: buildResponsesBody({ prompt, images, stream, tool }),
    requestedBody: {
      prompt,
      image_count: images.length,
      stream,
      response_format: firstString(formData, "response_format") || undefined,
    },
    responseFormat: normalizeResponseFormat(firstString(formData, "response_format")),
    stream,
  }
}

function responseRoot(value: unknown) {
  return isObject(value) && isObject(value.response) ? value.response : value
}

function imageMimeType(outputFormat: unknown) {
  const raw = safeTrim(outputFormat).toLowerCase()
  if (raw.includes("/")) return raw
  if (raw === "jpg" || raw === "jpeg") return "image/jpeg"
  if (raw === "webp") return "image/webp"
  return "image/png"
}

export function imagesApiResponseFromResponses(value: unknown, responseFormat: string) {
  const root = responseRoot(value)
  if (!isObject(root)) throw new Error("上游图片响应不是 JSON 对象")
  const output = Array.isArray(root.output) ? root.output : []
  const imageItems = output.filter((item) => isObject(item) && item.type === "image_generation_call")
  const data = imageItems
    .map((item) => {
      const result = safeTrim(item.result)
      if (!result) return null
      const payload: AnyRecord =
        responseFormat === "url"
          ? { url: `data:${imageMimeType(item.output_format)};base64,${result}` }
          : { b64_json: result }
      const revisedPrompt = safeTrim(item.revised_prompt)
      if (revisedPrompt) payload.revised_prompt = revisedPrompt
      return payload
    })
    .filter(Boolean)

  if (data.length === 0) throw new Error("上游没有返回 image_generation_call 结果")

  const first = imageItems[0] as AnyRecord | undefined
  const payload: AnyRecord = {
    created: Number(root.created_at || root.created) || Math.floor(Date.now() / 1000),
    data,
  }
  for (const key of ["background", "output_format", "quality", "size"]) {
    if (first?.[key]) payload[key] = first[key]
  }
  if (isObject(root.tool_usage?.image_gen)) payload.usage = root.tool_usage.image_gen
  else if (isObject(root.usage)) payload.usage = root.usage
  return payload
}
