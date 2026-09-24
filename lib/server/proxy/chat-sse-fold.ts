type AnyRecord = Record<string, any>

export interface ChatSseFrame {
  event: string
  payload: string
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

/** 一帧一帧地读 SSE 文本，只保留带 data 的帧。 */
export function parseChatSseFrames(text: string): ChatSseFrame[] {
  return String(text || "")
    .trimStart()
    .replace(/^\uFEFF/, "")
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      let event = ""
      const data: string[] = []
      for (const rawLine of frame.split(/\r?\n/)) {
        const line = rawLine.trimStart()
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
      }
      return { event, payload: data.join("\n") }
    })
    .filter((frame) => frame.payload)
}

/** delta.content 既可能是字符串，也可能是文本块数组。 */
function deltaText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((part) => {
      if (typeof part === "string") return part
      if (!isObject(part)) return ""
      return safeTrim(part.text) || (typeof part.content === "string" ? part.content : "")
    })
    .filter(Boolean)
    .join("")
}

/**
 * 把整段 chat SSE 折成一条 chat completion。
 *
 * 有的上游只提供流式回答（WorkBuddy 会直接 400 拒掉 stream:false），而客户端要的是一次性
 * JSON。只有拿到 SSE 文本时才折叠，其它形态原样返回，交给正常的 JSON 解析路径。
 */
export function foldChatSsePayload(payload: unknown): unknown {
  if (typeof payload !== "string" || !payload.includes("data:")) return payload
  const frames = parseChatSseFrames(payload)
  if (frames.length === 0) return payload

  const content: string[] = []
  const reasoning: string[] = []
  const toolCalls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()
  let id = ""
  let model = ""
  let created = 0
  let finishReason = ""
  let usage: unknown = null
  let sawChunk = false

  for (const frame of frames) {
    const text = frame.payload.trim()
    if (!text || text === "[DONE]") continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      continue
    }
    if (!isObject(parsed)) continue
    // 流中途报错时，错误体本身就是最终答案，直接交回上层统一处理。
    if (isObject(parsed.error)) return parsed
    sawChunk = true
    id = safeTrim(parsed.id) || id
    model = safeTrim(parsed.model) || model
    created = Number(parsed.created) || created
    if (parsed.usage != null) usage = parsed.usage

    const choices = Array.isArray(parsed.choices) ? parsed.choices : []
    for (const choice of choices) {
      if (!isObject(choice)) continue
      const delta = isObject(choice.delta)
        ? choice.delta
        : isObject(choice.message)
          ? choice.message
          : {}
      const chunkReasoning = safeTrim(delta.reasoning_content)
      if (chunkReasoning) reasoning.push(chunkReasoning)
      const chunkContent = deltaText(delta.content)
      if (chunkContent) content.push(chunkContent)
      for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (!isObject(rawCall)) continue
        const index = Number.isFinite(Number(rawCall.index))
          ? Number(rawCall.index)
          : toolCalls.size
        const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" }
        current.id = safeTrim(rawCall.id) || current.id
        const fn = isObject(rawCall.function) ? rawCall.function : {}
        current.name = safeTrim(fn.name) || current.name
        if (typeof fn.arguments === "string") current.arguments += fn.arguments
        else if (isObject(fn.arguments)) current.arguments += JSON.stringify(fn.arguments)
        toolCalls.set(index, current)
      }
      const reason = safeTrim(choice.finish_reason)
      if (reason) finishReason = reason
    }
  }
  if (!sawChunk) return payload

  const message: AnyRecord = { role: "assistant", content: content.join("") }
  if (reasoning.length > 0) message.reasoning_content = reasoning.join("")
  const calls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([index, call]) =>
      call.name
        ? [{
            id: call.id || `call_${index}`,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          }]
        : [],
    )
  if (calls.length > 0) message.tool_calls = calls

  return {
    id: id || `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || "stop" }],
    ...(usage ? { usage } : {}),
  }
}
