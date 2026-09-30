type AnyRecord = Record<string, any>

export interface ChatStreamTruthSnapshot {
  upstreamFinishReason: string
  finalFinishReason: string
  finishReasonSource: "upstream" | "synthesized" | "none"
  sawChoice: boolean
  sawDoneFrame: boolean
  toolCallCount: number
  lastInputItemType: string
  visibleChars: number
  reasoningChars: number
  settledAs: "completed" | "incomplete" | "failed" | "aborted"
}

export interface ChatStreamTruthSource {
  finishReason: string
  toolCallCount?: number
  sawChoice: boolean
  sawDone: boolean
  completed: boolean
  content: string
  reasoning: string
  inlineThinkBuffer: string
  inlineThinkMode: "detecting" | "reasoning" | "text"
}

const TOOL_RESULT_ITEM_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
])

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function lastInputItemTypeFromResponsesInput(input: unknown): string {
  if (typeof input === "string") {
    return "text"
  }
  if (!Array.isArray(input) || input.length === 0) return ""
  const last = input[input.length - 1]
  if (!isObject(last)) return ""
  return safeTrim(last.type)
}

export function chatStreamTruthFromSource(
  source: ChatStreamTruthSource,
  originalRequest: unknown,
  options: { aborted?: boolean } = {},
): ChatStreamTruthSnapshot {
  const upstreamFinishReason = safeTrim(source.finishReason)
  let finalFinishReason = upstreamFinishReason
  let finishReasonSource: ChatStreamTruthSnapshot["finishReasonSource"] =
    upstreamFinishReason ? "upstream" : "none"
  if (!source.completed && !source.sawDone && hasSubstantiveOutput(source)) {
    finalFinishReason = "length"
    finishReasonSource = "synthesized"
  } else if (!finalFinishReason && source.completed) {
    finalFinishReason = "stop"
    finishReasonSource = "synthesized"
  }
  return {
    upstreamFinishReason,
    finalFinishReason,
    finishReasonSource,
    sawChoice: source.sawChoice,
    sawDoneFrame: source.sawDone,
    toolCallCount: source.toolCallCount ?? 0,
    lastInputItemType: lastInputItemTypeFromResponsesInput(
      isObject(originalRequest) ? originalRequest.input : undefined,
    ),
    visibleChars: source.content.length,
    reasoningChars: source.reasoning.length + source.inlineThinkBuffer.length,
    settledAs: options.aborted
      ? "aborted"
      : source.completed
        ? upstreamFinishReason === "length"
          ? "incomplete"
          : "completed"
        : "failed",
  }
}

function hasSubstantiveOutput(source: ChatStreamTruthSource) {
  if (source.content.trim() || source.reasoning.trim() || source.inlineThinkBuffer.trim()) {
    return true
  }
  return (source.toolCallCount ?? 0) > 0
}

export function isToolResultItemType(type: string) {
  return TOOL_RESULT_ITEM_TYPES.has(type)
}
