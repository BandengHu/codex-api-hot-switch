import "server-only"

import {
  encodeAnthropicThinkingBlocks,
  type AnthropicThinkingBlock,
} from "./anthropic-thinking"
import {
  deserializeToolContext,
  toolCallAddedItem,
  toolCallItem,
  toolCallItemId,
  type ToolContext,
} from "./codex-tool-proxy"
import type { NativeAdapter } from "./native-canonical"
import { createChatCompletionsSseStream } from "./responses-sse"
import {
  geminiClientToolCallId,
  geminiUpstreamToolCallId,
  isSynthesizedGeminiToolCallId,
} from "./gemini-tool-ids"
import { rectifyGeminiToolCallArgs } from "./gemini-tool-args"
import { applyAssistantMessagePhase } from "./common"

type AnyRecord = Record<string, any>

const textEncoder = new TextEncoder()

interface GeminiToolCallSnapshot {
  callId: string
  name: string
  args: unknown
  thoughtSignature?: string
}

interface NativeSseTransformOptions {
  adapter: NativeAdapter
  model: string
}

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function sse(event: string, payload: unknown) {
  const prefix = event ? `event: ${event}\n` : ""
  return `${prefix}data: ${JSON.stringify(payload)}\n\n`
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function geminiThoughtSignature(part: AnyRecord) {
  return safeTrim(part.thoughtSignature ?? part.thought_signature) || undefined
}

function responseBase(id: string, model: string, status = "in_progress") {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output: [],
  }
}

function responseStartedFrame(responseId: string, model: string) {
  return sse("response.created", {
    type: "response.created",
    response: responseBase(responseId, model),
  })
}

function responseCompletedFrame(params: {
  responseId: string
  model: string
  output: AnyRecord[]
  outputText: string
  usage?: unknown
  status?: "completed" | "incomplete"
  incompleteReason?: string
}) {
  const status = params.status || "completed"
  return sse("response.completed", {
    type: "response.completed",
    response: {
      ...responseBase(params.responseId, params.model, status),
      output: params.output,
      output_text: params.outputText,
      usage: params.usage || undefined,
      incomplete_details:
        status === "incomplete"
          ? { reason: params.incompleteReason || "max_output_tokens" }
          : undefined,
    },
  })
}

function responseFailedFrame(params: {
  responseId: string
  model: string
  output?: AnyRecord[]
  message: string
  type?: string
}) {
  return sse("response.failed", {
    type: "response.failed",
    response: {
      ...responseBase(params.responseId, params.model, "failed"),
      output: params.output || [],
      error: {
        message: params.message,
        type: params.type || "server_error",
      },
    },
  })
}

function parseJsonPayload(payload: string) {
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

function splitSseFrame(text: string) {
  const crlf = text.indexOf("\r\n\r\n")
  const lf = text.indexOf("\n\n")
  if (crlf < 0 && lf < 0) return null
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    return { index: crlf, separatorLength: 4 }
  }
  return { index: lf, separatorLength: 2 }
}

function parseSseFrame(frameText: string) {
  let event = ""
  const data: string[] = []
  for (const rawLine of frameText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  return {
    event,
    data: data.join("\n"),
  }
}

class AnthropicToResponsesSse {
  private responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`
  private started = false
  private completed = false
  private output: AnyRecord[] = []
  private outputText = ""
  private contentIndexToOutputIndex = new Map<number, number>()
  private currentThinkingText = new Map<number, string>()
  private currentThinkingSignatures = new Map<number, string>()
  private currentRedactedThinking = new Map<number, string>()
  private currentToolArgs = new Map<number, string>()
  private currentToolNames = new Map<number, string>()
  private usage: unknown
  private stopReason = ""
  private latestReasoningText = ""
  private upstreamThinkingSeen = false
  private syntheticReasoningEmitted = false
  // 缓冲 message 的 output_item.done 帧：发出该帧时还不知道后面是否跟工具调用，
  // 无法确定 phase。先把文本 delta / output_text.done 正常流式发出（不影响渲染），
  // 把 output_item.done 挂起，等下一个内容块开始（commentary）或 message_stop
  // （final_answer）时带着正确 phase 再刷出，桌面端即可在收到 done 帧时直接折叠。
  private pendingMessage: { outputIndex: number; item: AnyRecord } | null = null

  private toolContext: ToolContext

  constructor(
    private model: string,
    private reverseToolNameMap: Record<string, string> = {},
    serializedToolContext?: NativeAdapter["toolContext"],
    private reasoningEnabled = false,
  ) {
    this.toolContext = deserializeToolContext(serializedToolContext)
  }

  private mergeUsage(next: AnyRecord) {
    const base = isObject(this.usage) ? { ...this.usage } : {}
    for (const [key, value] of Object.entries(next)) {
      if (value == null) continue
      base[key] = value
    }
    this.usage = base
  }

  // 合成 reasoning item 使用的占位 contentIndex（不与上游 index 冲突），
  // 以便复用 completeOpenItems 的统一收尾逻辑。
  private static readonly SYNTHETIC_REASONING_CONTENT_INDEX = -1

  // 当上游不返回任何 thinking 块、但本轮开启了推理时，补一个空的 reasoning item，
  // 让 Codex 桌面端能把随后的工具/文本折叠进“思考”容器。该 item 的 summary 为空、
  // 不带 encrypted_content，与原生空 reasoning 结构一致，且不会回传到上游历史。
  private ensureLeadingReasoningItem() {
    if (
      !this.reasoningEnabled ||
      this.upstreamThinkingSeen ||
      this.syntheticReasoningEmitted
    ) {
      return ""
    }
    this.syntheticReasoningEmitted = true
    const outputIndex = this.output.length
    const item = {
      id: `rs_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "reasoning",
      status: "in_progress",
      reasoning_content: "",
      summary: [] as AnyRecord[],
    }
    this.output.push(item)
    this.contentIndexToOutputIndex.set(
      AnthropicToResponsesSse.SYNTHETIC_REASONING_CONTENT_INDEX,
      outputIndex,
    )
    return (
      sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      }) + this.reasoningSummaryPartAdded(outputIndex, item.id)
    )
  }

  private completeSyntheticReasoningItem() {
    const outputIndex = this.contentIndexToOutputIndex.get(
      AnthropicToResponsesSse.SYNTHETIC_REASONING_CONTENT_INDEX,
    )
    if (outputIndex == null) return ""
    const item = this.output[outputIndex]
    if (!isObject(item) || item.status === "completed") return ""
    return this.finishContentBlock(
      AnthropicToResponsesSse.SYNTHETIC_REASONING_CONTENT_INDEX,
      outputIndex,
      item,
    )
  }

  processFrame(event: string, payload: unknown) {
    if (!isObject(payload)) return ""
    let out = ""
    if (!this.started) {
      this.started = true
      const upstreamId = typeof payload.message?.id === "string" ? payload.message.id : ""
      if (upstreamId) this.responseId = upstreamId
      out += responseStartedFrame(this.responseId, this.model)
    }
    if (isObject(payload.usage)) this.mergeUsage(payload.usage)
    if (isObject(payload.message) && isObject(payload.message.usage)) {
      this.mergeUsage(payload.message.usage)
    }

    const type = String(payload.type || event || "")
    if (type === "content_block_start") {
      out += this.handleContentBlockStart(payload)
    } else if (type === "content_block_delta") {
      out += this.handleContentBlockDelta(payload)
    } else if (type === "content_block_stop") {
      out += this.handleContentBlockStop(payload)
    } else if (type === "message_delta") {
      if (isObject(payload.usage)) this.mergeUsage(payload.usage)
      if (isObject(payload.delta) && typeof payload.delta.stop_reason === "string") {
        this.stopReason = payload.delta.stop_reason
      }
    } else if (type === "message_stop") {
      this.completed = true
      // 收尾仍处于 in_progress 的合成 reasoning item（它没有对应的
      // content_block_stop）。其余块在 content_block_stop 时已 completed，
      // finishContentBlock 对已完成项返回空串，故此调用安全幂等。
      out += this.completeOpenItems()
      // 回合末尾：挂起的 message 就是最终答案，按 final_answer 刷出 done 帧。
      out += this.flushPendingMessage("final_answer")
      applyAssistantMessagePhase(this.output)
      out += responseCompletedFrame({
        responseId: this.responseId,
        model: this.model,
        output: this.output,
        outputText: this.outputText,
        usage: openAIUsageFromAnthropicStream(this.usage),
        status: this.stopReason === "max_tokens" ? "incomplete" : "completed",
        incompleteReason:
          this.stopReason === "max_tokens" ? "max_output_tokens" : undefined,
      })
      out += "data: [DONE]\n\n"
    }
    return out
  }

  finish() {
    if (this.completed) return ""
    if (!this.started) {
      this.started = true
      this.completed = true
      return (
        responseStartedFrame(this.responseId, this.model) +
        responseFailedFrame({
          responseId: this.responseId,
          model: this.model,
          message: "Upstream Anthropic stream ended before sending message_stop",
          type: "stream_truncated",
        }) +
        "data: [DONE]\n\n"
      )
    }
    this.completed = true
    if (!this.hasSubstantiveOutput()) {
      return (
        responseFailedFrame({
          responseId: this.responseId,
          model: this.model,
          output: this.output,
          message: "Upstream Anthropic stream ended before sending message_stop",
          type: "stream_truncated",
        }) +
        "data: [DONE]\n\n"
      )
    }
    const completeItems = this.completeOpenItems()
    const flushMessage = this.flushPendingMessage("final_answer")
    applyAssistantMessagePhase(this.output)
    return (
      completeItems +
      flushMessage +
      responseCompletedFrame({
        responseId: this.responseId,
        model: this.model,
        output: this.output,
        outputText: this.outputText,
        usage: openAIUsageFromAnthropicStream(this.usage),
        status: "incomplete",
        incompleteReason: "max_output_tokens",
      }) +
      "data: [DONE]\n\n"
    )
  }

  private handleContentBlockStart(payload: AnyRecord) {
    const block = payload.content_block
    if (!isObject(block)) return ""
    // 又有新内容块到来，说明上一个 message 不是回合末尾，按 commentary 刷出其 done 帧。
    let out = this.flushPendingMessage("commentary")
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      this.upstreamThinkingSeen = true
    } else {
      // 上游（如部分 Claude 中转）即使收到 thinking 参数也只回 text/tool_use，
      // 不发任何 thinking 块，导致没有 reasoning item，Codex 桌面端无法把工具行
      // 折叠进“思考”容器。这里在首个非 thinking 块前补一个空的 reasoning item，
      // 结构与原生 reasoning 一致（summary 为空、无 encrypted_content），仅用于折叠，
      // 不会回传到上游历史（native-canonical 对空 thinking 会丢弃）。
      out += this.ensureLeadingReasoningItem()
      out += this.completeSyntheticReasoningItem()
    }
    const contentIndex = Number(payload.index ?? this.output.length)
    const outputIndex = this.output.length
    this.contentIndexToOutputIndex.set(contentIndex, outputIndex)
    if (block.type === "text") {
      const item = {
        id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [] as AnyRecord[],
      }
      this.output.push(item)
      out += sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      })
      if (typeof block.text === "string" && block.text) {
        out += this.appendTextDelta(outputIndex, item.id, block.text)
      }
      return out
    }
    if (block.type === "thinking") {
      const item = {
        id: `rs_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "reasoning",
        status: "in_progress",
        reasoning_content: "",
        summary: [] as AnyRecord[],
      }
      this.output.push(item)
      this.currentThinkingText.set(contentIndex, String(block.thinking || ""))
      if (typeof block.thinking === "string" && block.thinking) {
        this.latestReasoningText += block.thinking
      }
      if (typeof block.signature === "string" && block.signature) {
        this.currentThinkingSignatures.set(contentIndex, block.signature)
      }
      out += sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      })
      out += this.reasoningSummaryPartAdded(outputIndex, item.id)
      if (typeof block.thinking === "string" && block.thinking) {
        out += this.appendReasoningDelta(outputIndex, item.id, block.thinking)
      }
      return out
    }
    if (block.type === "redacted_thinking") {
      const item = {
        id: `rs_${crypto.randomUUID().replaceAll("-", "")}`,
        type: "reasoning",
        status: "in_progress",
        reasoning_content: "",
        summary: [] as AnyRecord[],
      }
      this.output.push(item)
      if (typeof block.data === "string" && block.data) {
        this.currentRedactedThinking.set(contentIndex, block.data)
      }
      return out + sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      }) + this.reasoningSummaryPartAdded(outputIndex, item.id)
    }
    if (block.type === "tool_use") {
      const name = this.reverseToolNameMap[String(block.name || "")] || String(block.name || "")
      const item = {
        ...toolCallAddedItem(
          String(block.id || `tool_${outputIndex}`),
          name,
          this.toolContext,
          this.latestReasoningText,
        ),
        id: toolCallItemId(
          String(block.id || `tool_${outputIndex}`),
          name,
          this.toolContext,
        ),
      }
      this.output.push(item)
      this.currentToolArgs.set(contentIndex, "")
      this.currentToolNames.set(contentIndex, name)
      return out + sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      })
    }
    return out
  }

  private handleContentBlockDelta(payload: AnyRecord) {
    const contentIndex = Number(payload.index ?? -1)
    const outputIndex = this.contentIndexToOutputIndex.get(contentIndex)
    if (outputIndex == null) return ""
    const item = this.output[outputIndex]
    const delta = payload.delta
    if (!isObject(delta) || !isObject(item)) return ""
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      return this.appendTextDelta(outputIndex, item.id, delta.text)
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      const previous = this.currentThinkingText.get(contentIndex) || ""
      this.currentThinkingText.set(contentIndex, previous + delta.thinking)
      this.latestReasoningText += delta.thinking
      return this.appendReasoningDelta(outputIndex, item.id, delta.thinking)
    }
    if (delta.type === "signature_delta" && typeof delta.signature === "string") {
      const previous = this.currentThinkingSignatures.get(contentIndex) || ""
      this.currentThinkingSignatures.set(contentIndex, previous + delta.signature)
      return ""
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const previous = this.currentToolArgs.get(contentIndex) || ""
      this.currentToolArgs.set(contentIndex, previous + delta.partial_json)
      if (item.type !== "function_call") return ""
      return sse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        output_index: outputIndex,
        item_id: item.id,
        delta: delta.partial_json,
      })
    }
    return ""
  }

  private handleContentBlockStop(payload: AnyRecord) {
    const contentIndex = Number(payload.index ?? -1)
    const outputIndex = this.contentIndexToOutputIndex.get(contentIndex)
    if (outputIndex == null) return ""
    const item = this.output[outputIndex]
    if (!isObject(item)) return ""
    return this.finishContentBlock(contentIndex, outputIndex, item)
  }

  private finishContentBlock(contentIndex: number, outputIndex: number, item: AnyRecord) {
    if (item.status === "completed") return ""
    if (item.type === "message") {
      item.status = "completed"
      // 若已有挂起的 message，说明它后面还跟着当前这个 message，即不是回合末尾，
      // 按 commentary 刷出后再挂起当前 message。
      const flushPrev = this.flushPendingMessage("commentary")
      // output_text.done 立即发出（不影响正文渲染速度），但 output_item.done 先挂起，
      // 等确定该 message 是回合中途叙述（commentary）还是最终答案（final_answer）后，
      // 带着 phase 再刷出，桌面端才能在收到 done 帧时直接折叠而不用手动点。
      const textDone = sse("response.output_text.done", {
        type: "response.output_text.done",
        output_index: outputIndex,
        item_id: item.id,
        text: item.content?.[0]?.text || "",
      })
      this.pendingMessage = { outputIndex, item }
      return flushPrev + textDone
    }
    if (item.type === "reasoning") {
      item.status = "completed"
      const text = this.reasoningTextForContentBlock(contentIndex, item)
      item.reasoning_content = text
      if (!Array.isArray(item.summary) || item.summary.length === 0) {
        item.summary = [{ type: "summary_text", text }]
      } else {
        item.summary[0] = { ...item.summary[0], type: "summary_text", text }
      }
      const encryptedContent = this.encryptedThinkingContent(contentIndex)
      if (encryptedContent) item.encrypted_content = encryptedContent
      return sse("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        output_index: outputIndex,
        item_id: item.id,
        summary_index: 0,
        text,
      }) + sse("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        output_index: outputIndex,
        item_id: item.id,
        summary_index: 0,
        part: { type: "summary_text", text },
      }) + sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      })
    }
    if (item.type === "function_call") {
      item.status = "completed"
      item.arguments = this.currentToolArgs.get(contentIndex) || "{}"
      return sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        output_index: outputIndex,
        item_id: item.id,
        arguments: item.arguments,
      }) + sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      })
    }
    if (item.type === "custom_tool_call" || item.type === "tool_search_call") {
      const name = this.currentToolNames.get(contentIndex) ||
        (item.type === "tool_search_call" ? "tool_search" : String(item.name || ""))
      const args = this.currentToolArgs.get(contentIndex) || "{}"
      const completed = toolCallItem(
        String(item.call_id || item.id || `tool_${outputIndex}`),
        name,
        args,
        this.toolContext,
        this.latestReasoningText,
      )
      this.output[outputIndex] = completed
      const customDelta =
        completed.type === "custom_tool_call"
          ? sse("response.custom_tool_call_input.delta", {
              type: "response.custom_tool_call_input.delta",
              item_id: completed.id,
              call_id: completed.call_id,
              output_index: outputIndex,
              delta: completed.input || "",
            })
          : ""
      const customDone =
        completed.type === "custom_tool_call"
          ? sse("response.custom_tool_call_input.done", {
              type: "response.custom_tool_call_input.done",
              item_id: completed.id,
              call_id: completed.call_id,
              output_index: outputIndex,
              input: completed.input || "",
            })
          : ""
      return customDelta + customDone + sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: completed,
      })
    }
    return ""
  }

  // 刷出挂起的 message output_item.done 帧，带上 phase。
  // phase 为空时（理论上不会）不写字段，交由后续 applyAssistantMessagePhase 兜底。
  private flushPendingMessage(phase: "commentary" | "final_answer") {
    const pending = this.pendingMessage
    if (!pending) return ""
    this.pendingMessage = null
    if (pending.item.phase == null) pending.item.phase = phase
    return sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: pending.outputIndex,
      item: pending.item,
    })
  }

  private encryptedThinkingContent(contentIndex: number) {
    const blocks: AnthropicThinkingBlock[] = []
    const redactedData = this.currentRedactedThinking.get(contentIndex)
    if (redactedData) {
      blocks.push({ type: "redacted_thinking", data: redactedData })
    }

    const signature = this.currentThinkingSignatures.get(contentIndex)
    if (signature) {
      blocks.push({
        type: "thinking",
        thinking: this.currentThinkingText.get(contentIndex) || "",
        signature,
      })
    }
    return encodeAnthropicThinkingBlocks(blocks)
  }

  private completeOpenItems() {
    let out = ""
    for (const [contentIndex, outputIndex] of this.contentIndexToOutputIndex) {
      const item = this.output[outputIndex]
      if (isObject(item)) out += this.finishContentBlock(contentIndex, outputIndex, item)
    }
    return out
  }

  private hasSubstantiveOutput() {
    if (this.outputText.trim()) return true
    if (this.output.length > 0) return true
    for (const args of this.currentToolArgs.values()) {
      if (args.trim()) return true
    }
    return false
  }

  private appendTextDelta(outputIndex: number, itemId: string, text: string) {
    const item = this.output[outputIndex]
    if (isObject(item)) {
      if (!Array.isArray(item.content) || item.content.length === 0) {
        item.content = [{ type: "output_text", text: "" }]
      }
      item.content[0].text = `${item.content[0].text || ""}${text}`
    }
    this.outputText += text
    return sse("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: outputIndex,
      item_id: itemId,
      delta: text,
    })
  }

  private appendReasoningDelta(outputIndex: number, itemId: string, text: string) {
    const item = this.output[outputIndex]
    if (isObject(item)) {
      item.reasoning_content = `${item.reasoning_content || ""}${text}`
      if (!Array.isArray(item.summary) || item.summary.length === 0) {
        item.summary = [{ type: "summary_text", text: "" }]
      }
      item.summary[0].text = `${item.summary[0].text || ""}${text}`
    }
    return sse("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      output_index: outputIndex,
      item_id: itemId,
      summary_index: 0,
      delta: text,
    })
  }

  private reasoningSummaryPartAdded(outputIndex: number, itemId: string) {
    return sse("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      output_index: outputIndex,
      item_id: itemId,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    })
  }

  private reasoningTextForContentBlock(contentIndex: number, item: AnyRecord) {
    const current = this.currentThinkingText.get(contentIndex)
    if (typeof current === "string" && current) return current
    if (typeof item.reasoning_content === "string" && item.reasoning_content) {
      return item.reasoning_content
    }
    const summaryText = Array.isArray(item.summary)
      ? item.summary.find(
          (part: AnyRecord) => part?.type === "summary_text" && typeof part.text === "string",
        )?.text
      : ""
    return typeof summaryText === "string" ? summaryText : ""
  }
}

function openAIUsageFromAnthropicStream(usage: unknown) {
  if (!isObject(usage)) return undefined
  const inputTokens = Number(usage.input_tokens ?? 0)
  const outputTokens = Number(usage.output_tokens ?? 0)
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0)
  const cacheCreationTokens =
    Number(usage.cache_creation_input_tokens ?? 0) +
    Number(usage.cache_creation_5m_input_tokens ?? 0) +
    Number(usage.cache_creation_1h_input_tokens ?? 0)
  const totalInputTokens =
    (Number.isFinite(inputTokens) ? inputTokens : 0) +
    (Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0) +
    (Number.isFinite(cacheCreationTokens) ? cacheCreationTokens : 0)
  const result: AnyRecord = {
    input_tokens: totalInputTokens,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: totalInputTokens + (Number.isFinite(outputTokens) ? outputTokens : 0),
  }
  if (Number.isFinite(cacheReadTokens) && cacheReadTokens > 0) {
    result.input_tokens_details = { cached_tokens: cacheReadTokens }
  }
  if (Number.isFinite(cacheCreationTokens) && cacheCreationTokens > 0) {
    result.cache_creation_input_tokens = cacheCreationTokens
  }
  return result
}

class GeminiToResponsesSse {
  private responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`
  private started = false
  private completed = false
  private output: AnyRecord[] = []
  private outputText = ""
  private textItemIndex: number | null = null
  private usage: unknown
  private latestReasoningText = ""
  private accumulatedVisibleText = ""
  private accumulatedReasoningText = ""
  private blockedText = ""
  private toolCallSnapshots: GeminiToolCallSnapshot[] = []
  private toolCallsFlushed = false

  private toolContext: ToolContext

  constructor(
    private model: string,
    private reverseToolNameMap: Record<string, string> = {},
    serializedToolContext?: NativeAdapter["toolContext"],
    private adapter: Pick<NativeAdapter, "geminiToolSchemaHints"> = {},
  ) {
    this.toolContext = deserializeToolContext(serializedToolContext)
  }

  processPayload(payload: unknown) {
    if (!isObject(payload)) return ""
    let out = ""
    if (!this.started) {
      this.started = true
      out += responseStartedFrame(this.responseId, this.model)
    }
    if (isObject(payload.usageMetadata)) {
      this.usage = payload.usageMetadata
    }
    const blockReason = typeof payload.promptFeedback?.blockReason === "string"
      ? payload.promptFeedback.blockReason.trim()
      : ""
    if (blockReason) {
      this.blockedText = `Request blocked by Gemini safety filters: ${blockReason}`
    }
    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null
    const parts = candidate?.content?.parts
    if (Array.isArray(parts)) {
      let functionCallPosition = 0
      let visibleText = ""
      let reasoningText = ""
      for (const part of parts) {
        if (!isObject(part)) continue
        if (typeof part.text === "string") {
          if (part.thought === true || isObject(part.thought)) {
            reasoningText += part.text
          } else {
            visibleText += part.text
          }
        } else if (isObject(part.functionCall)) {
          this.rememberFunctionCall(
            part.functionCall,
            functionCallPosition,
            geminiThoughtSignature(part),
          )
          functionCallPosition += 1
        }
      }
      out += this.appendCumulativeReasoning(reasoningText)
      out += this.appendCumulativeText(visibleText)
    }
    if (candidate?.finishReason) {
      this.completed = true
      const incomplete = String(candidate.finishReason || "").toUpperCase() === "MAX_TOKENS"
      out += this.completeOpenItems()
      out += this.flushFunctionCalls()
      out += responseCompletedFrame({
        responseId: this.responseId,
        model: this.model,
        output: this.output,
        outputText: this.outputText,
        usage: openAIUsageFromGeminiStream(this.usage),
        status: incomplete ? "incomplete" : "completed",
        incompleteReason: incomplete ? "max_output_tokens" : undefined,
      })
      out += "data: [DONE]\n\n"
    }
    return out
  }

  finish() {
    if (this.completed) return ""
    if (this.blockedText) {
      this.completed = true
      return (
        this.appendCumulativeText(this.blockedText) +
        this.completeOpenItems() +
        responseCompletedFrame({
          responseId: this.responseId,
          model: this.model,
          output: this.output,
          outputText: this.outputText,
          usage: openAIUsageFromGeminiStream(this.usage),
        }) +
        "data: [DONE]\n\n"
      )
    }
    if (!this.started) {
      this.started = true
      this.completed = true
      return (
        responseStartedFrame(this.responseId, this.model) +
        responseFailedFrame({
          responseId: this.responseId,
          model: this.model,
          message: "Upstream Gemini stream ended before sending finishReason",
          type: "stream_truncated",
        }) +
        "data: [DONE]\n\n"
      )
    }
    this.completed = true
    if (!this.hasSubstantiveOutput()) {
      return (
        responseFailedFrame({
          responseId: this.responseId,
          model: this.model,
          output: this.output,
          message: "Upstream Gemini stream ended before sending finishReason",
          type: "stream_truncated",
        }) +
        "data: [DONE]\n\n"
      )
    }
    return (
      this.completeOpenItems() +
      this.flushFunctionCalls() +
      responseCompletedFrame({
        responseId: this.responseId,
        model: this.model,
        output: this.output,
        outputText: this.outputText,
        usage: openAIUsageFromGeminiStream(this.usage),
        status: "incomplete",
        incompleteReason: "max_output_tokens",
      }) +
      "data: [DONE]\n\n"
    )
  }

  private ensureTextItem() {
    if (this.textItemIndex != null) return this.textItemIndex
    const outputIndex = this.output.length
    const item = {
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [{ type: "output_text", text: "" }],
    }
    this.output.push(item)
    this.textItemIndex = outputIndex
    return outputIndex
  }

  private appendText(text: string) {
    const outputIndex = this.ensureTextItem()
    const item = this.output[outputIndex]
    if (item.content.length === 1) item.content[0].text += text
    this.outputText += text
    let out = ""
    if (item.status === "in_progress" && item.content[0].text === text) {
      out += sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      })
    }
    out += sse("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: outputIndex,
      item_id: item.id,
      delta: text,
    })
    return out
  }

  private appendCumulativeText(text: string) {
    if (!text) return ""
    const isCumulative = text.startsWith(this.accumulatedVisibleText)
    const delta = isCumulative ? text.slice(this.accumulatedVisibleText.length) : text
    if (!delta) return ""
    this.accumulatedVisibleText = isCumulative ? text : `${this.accumulatedVisibleText}${delta}`
    return this.appendText(delta)
  }

  private completeOpenItems() {
    let out = ""
    if (this.textItemIndex != null) {
      const item = this.output[this.textItemIndex]
      if (item?.status !== "completed") {
        item.status = "completed"
        out += sse("response.output_text.done", {
          type: "response.output_text.done",
          output_index: this.textItemIndex,
          item_id: item.id,
          text: item.content?.[0]?.text || "",
        })
        out += sse("response.output_item.done", {
          type: "response.output_item.done",
          output_index: this.textItemIndex,
          item,
        })
      }
    }
    return out
  }

  private rememberFunctionCall(functionCall: AnyRecord, position: number, thoughtSignature?: string) {
    const upstreamId = geminiUpstreamToolCallId(functionCall.id)
    const existing =
      upstreamId
        ? this.toolCallSnapshots.findIndex((snapshot) => snapshot.callId === upstreamId)
        : -1
    const positional = this.toolCallSnapshots[position]
    const positionalCanMerge =
      positional &&
      (!upstreamId || isSynthesizedGeminiToolCallId(positional.callId))
    const index = existing >= 0 ? existing : positionalCanMerge ? position : -1
    const snapshot: GeminiToolCallSnapshot = {
      callId: upstreamId || positional?.callId || geminiClientToolCallId(undefined),
      name: String(functionCall.name || positional?.name || ""),
      args: rectifyGeminiToolCallArgs(
        String(functionCall.name || positional?.name || ""),
        functionCall.args ?? positional?.args ?? {},
        this.adapter.geminiToolSchemaHints,
      ),
      thoughtSignature: thoughtSignature || positional?.thoughtSignature,
    }

    if (index >= 0) {
      this.toolCallSnapshots[index] = snapshot
    } else {
      this.toolCallSnapshots.push(snapshot)
    }
  }

  private flushFunctionCalls() {
    if (this.toolCallsFlushed) return ""
    this.toolCallsFlushed = true
    let out = ""
    for (const snapshot of this.toolCallSnapshots) {
      out += this.appendFunctionCallSnapshot(snapshot)
    }
    return out
  }

  private appendFunctionCallSnapshot(snapshot: GeminiToolCallSnapshot) {
    const outputIndex = this.output.length
    const callId = snapshot.callId
    const name = this.reverseToolNameMap[snapshot.name] || snapshot.name
    const args = JSON.stringify(snapshot.args || {})
    const item = toolCallItem(callId, name, args, this.toolContext, this.latestReasoningText)
    const addedItem = toolCallAddedItem(callId, name, this.toolContext, this.latestReasoningText)
    if (snapshot.thoughtSignature) {
      item.gemini_thought_signature = snapshot.thoughtSignature
      addedItem.gemini_thought_signature = snapshot.thoughtSignature
    }
    this.output.push(item)
    if (item.type !== "function_call") {
      const customDelta =
        item.type === "custom_tool_call"
          ? sse("response.custom_tool_call_input.delta", {
              type: "response.custom_tool_call_input.delta",
              item_id: item.id,
              call_id: item.call_id,
              output_index: outputIndex,
              delta: item.input || "",
            })
          : ""
      const customDone =
        item.type === "custom_tool_call"
          ? sse("response.custom_tool_call_input.done", {
              type: "response.custom_tool_call_input.done",
              item_id: item.id,
              call_id: item.call_id,
              output_index: outputIndex,
              input: item.input || "",
            })
          : ""
      return sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: addedItem,
      }) + customDelta + customDone + sse("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      })
    }
    return sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: addedItem,
    }) + sse("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: outputIndex,
      item_id: item.id,
      delta: item.arguments,
    }) + sse("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: item.id,
      arguments: item.arguments,
    }) + sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    })
  }

  private appendReasoning(text: string) {
    const outputIndex = this.output.length
    const item = {
      id: `rs_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text }],
    }
    this.output.push(item)
    return sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    }) + sse("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      output_index: outputIndex,
      item_id: item.id,
      delta: text,
    }) + sse("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      output_index: outputIndex,
      item_id: item.id,
      text,
    }) + sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    })
  }

  private appendCumulativeReasoning(text: string) {
    if (!text) return ""
    const isCumulative = text.startsWith(this.accumulatedReasoningText)
    const delta = isCumulative ? text.slice(this.accumulatedReasoningText.length) : text
    if (!delta) return ""
    this.accumulatedReasoningText = isCumulative
      ? text
      : `${this.accumulatedReasoningText}${delta}`
    this.latestReasoningText += delta
    return this.appendReasoning(delta)
  }

  private hasSubstantiveOutput() {
    return Boolean(
      this.outputText.trim() ||
      this.output.length > 0 ||
      this.toolCallSnapshots.length > 0,
    )
  }
}

function openAIUsageFromGeminiStream(usage: unknown) {
  if (!isObject(usage)) return undefined
  const inputTokens = Number(usage.promptTokenCount ?? 0)
  const outputTokens = Number(usage.candidatesTokenCount ?? 0)
  const totalTokens = Number(usage.totalTokenCount ?? inputTokens + outputTokens)
  const result: AnyRecord = {
    input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    total_tokens: Number.isFinite(totalTokens)
      ? totalTokens
      : (Number.isFinite(inputTokens) ? inputTokens : 0) +
        (Number.isFinite(outputTokens) ? outputTokens : 0),
  }
  const cachedTokens = Number(usage.cachedContentTokenCount ?? 0)
  if (Number.isFinite(cachedTokens) && cachedTokens > 0) {
    result.input_tokens_details = { cached_tokens: cachedTokens }
  }
  return result
}

function createNativeResponsesSseStream(options: NativeSseTransformOptions) {
  const decoder = new TextDecoder()
  let buffer = ""
  const transformer =
    options.adapter.protocol === "anthropic"
        ? new AnthropicToResponsesSse(
            options.model,
            options.adapter.reverseToolNameMap,
            options.adapter.toolContext,
            options.adapter.reasoningEnabled,
          )
      : new GeminiToResponsesSse(
          options.model,
          options.adapter.reverseToolNameMap,
          options.adapter.toolContext,
          options.adapter,
        )

  function processFrame(frameText: string) {
    if (options.adapter.protocol === "anthropic") {
      const frame = parseSseFrame(frameText)
      const payload = parseJsonPayload(frame.data)
      return payload
        ? (transformer as AnthropicToResponsesSse).processFrame(frame.event, payload)
        : ""
    }
    const frame = parseSseFrame(frameText)
    const payload = parseJsonPayload(frame.data || frameText)
    return payload ? (transformer as GeminiToResponsesSse).processPayload(payload) : ""
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      while (true) {
        const boundary = splitSseFrame(buffer)
        if (!boundary) break
        const frameText = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.separatorLength)
        const out = processFrame(frameText)
        if (out) controller.enqueue(textEncoder.encode(out))
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer.trim()) {
        const out = processFrame(buffer)
        if (out) controller.enqueue(textEncoder.encode(out))
      }
      const tail = transformer.finish()
      if (tail) controller.enqueue(textEncoder.encode(tail))
    },
  })
}

export function createNativeSseStreamToClient(options: NativeSseTransformOptions) {
  const responsesStream = createNativeResponsesSseStream(options)
  if (options.adapter.source === "chat_completions") {
    const chatStream = createChatCompletionsSseStream(
      options.adapter.requestedModel,
      options.adapter.reverseToolNameMap,
    )
    void responsesStream.readable
      .pipeTo(chatStream.writable)
      .catch(() => undefined)
    return {
      writable: responsesStream.writable,
      readable: chatStream.readable,
    }
  }
  return responsesStream
}
