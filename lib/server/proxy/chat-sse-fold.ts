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

/**
 * 上游会把空的工具占位符原样带进每一帧：`"tool_calls": []`、`"function_call": null`，
 * WorkBuddy 甚至连 `{"name":"","arguments":""}` 这种空壳都在每帧带上。
 *
 * 这里判的是「这一帧有没有带任何信息」——空占位符要丢掉，但只带 `id` 的开场帧必须留下，
 * 否则后面补上名字时已经没地方挂了，整个工具调用会凭空消失。
 */
export function chatToolDeltaHasContent(value: unknown) {
  if (!isObject(value)) return false
  const fn = isObject(value.function) ? value.function : value
  return Boolean(safeTrim(value.id) || safeTrim(fn.name) || safeTrim(fn.arguments))
}

/**
 * 这一帧是不是「真的开始调用工具」。
 *
 * 只有带出名字或参数才算数：这才是推理该收尾的边界。像 WorkBuddy 那样每帧都塞一个
 * 只有 id 的空壳时，不能拿它当边界，否则推理在第一个 delta 就被收尾，客户端只剩前几个字。
 */
export function chatToolDeltaStartsCall(value: unknown) {
  if (!isObject(value)) return false
  const fn = isObject(value.function) ? value.function : value
  return Boolean(safeTrim(fn.name) || safeTrim(fn.arguments))
}

/**
 * 上游这一轮到底有没有交出东西。
 *
 * 三种情况都算有产出，不能报成失败：
 * - 有可见正文或工具调用（常规回答）；
 * - 被 `finish_reason=length` 截断但已经给出推理——额度花在思考上、正文还没开写就被
 *   掐掉，是上游的正常收尾，推理本身就是这一轮的产出，报失败会让调用方丢掉已经拿到的内容；
 * - 除了上面两种以外，只要没有任何产出才是真的空响应。
 *
 * `reasoning` 只在截断时才算产出：上游正常结束时只给推理不给正文，说明这一轮确实没
 * 生成出可用的答案，那时候报错是对的。
 */
export function chatStreamHasUsableOutput(params: {
  hasVisibleMessage: boolean
  hasToolCall: boolean
  reasoning: string
  finishReason: string
}) {
  if (params.hasVisibleMessage || params.hasToolCall) return true
  if (params.finishReason.trim().toLowerCase() !== "length") return false
  return Boolean(params.reasoning.trim())
}

/**
 * 取出这一帧要合并的工具调用增量，保留它在原数组里的下标作为兜底索引。
 * `function_call` 是单数形式的旧字段，统一包装成带 index 的形态。
 */
export function chatToolDeltas(payload: AnyRecord) {
  const deltas: Array<{ position: number; value: AnyRecord; startsCall: boolean }> = []
  if (Array.isArray(payload.tool_calls)) {
    payload.tool_calls.forEach((entry, position) => {
      if (chatToolDeltaHasContent(entry)) {
        deltas.push({ position, value: entry, startsCall: chatToolDeltaStartsCall(entry) })
      }
    })
    return deltas
  }
  if (chatToolDeltaHasContent(payload.function_call)) {
    const fn = payload.function_call as AnyRecord
    deltas.push({
      position: 0,
      value: { index: 0, id: fn.id, type: "function", function: fn },
      startsCall: chatToolDeltaStartsCall(fn),
    })
  }
  return deltas
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
      // 文本块同样按 token 切片，空格是内容的一部分，不能 trim。
      if (typeof part.text === "string") return part.text
      return typeof part.content === "string" ? part.content : ""
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
      // 推理增量按 token 切开，空格常单独成帧或挂在片头，trim 会把它粘成
      // "Simplequestion"。这里原样保留，只跳过空串。
      const chunkReasoning = typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : ""
      if (chunkReasoning) reasoning.push(chunkReasoning)
      const chunkContent = deltaText(delta.content)
      if (chunkContent) content.push(chunkContent)
      for (const { position, value: rawCall } of chatToolDeltas(delta)) {
        const index = Number.isFinite(Number(rawCall.index))
          ? Number(rawCall.index)
          : position
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
