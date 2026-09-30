import "server-only"

import type { TokenUsage } from "@/lib/types"
import { responseId } from "./common"

type AnyRecord = Record<string, any>

const SUMMARY_OUTPUT_TOKENS = 2048
const MAX_CONTEXT_CHARS = 48_000
const RECENT_CONTEXT_CHARS = 16_000
const TOOL_OUTPUT_MAX_CHARS = 2_000

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeString(value: unknown) {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function truncateText(value: string, limit: number) {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`
}

function textFromContent(content: unknown) {
  if (content == null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return safeString(content)
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!isObject(part)) return safeString(part)
      if (typeof part.text === "string") return part.text
      if (typeof part.content === "string") return part.content
      if (typeof part.output === "string") return part.output
      if (part.type === "input_image" || part.type === "image_url") return "[Attached image]"
      if (part.type === "input_file" || part.type === "file") {
        return `[Attached file${part.filename ? `: ${part.filename}` : ""}]`
      }
      return safeString(part)
    })
    .filter(Boolean)
    .join("\n")
}

function serializeResponsesItem(item: unknown) {
  if (typeof item === "string") return `[User]: ${item}`
  if (!isObject(item)) return ""
  const type = String(item.type || "")
  if (type === "function_call" || type === "custom_tool_call") {
    const name = safeString(item.name || item.tool_name || "tool")
    const args = safeString(item.arguments || item.input || "")
    return `[Assistant tool call]: ${name}(${truncateText(args, TOOL_OUTPUT_MAX_CHARS)})`
  }
  if (
    type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "tool_result"
  ) {
    return `[Tool result]: ${truncateText(textFromContent(item.output ?? item.content), TOOL_OUTPUT_MAX_CHARS)}`
  }
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.map((part) => textFromContent([part])).join("\n")
      : textFromContent(item.summary ?? item.content ?? item.text)
    return summary ? `[Assistant reasoning]: ${truncateText(summary, TOOL_OUTPUT_MAX_CHARS)}` : ""
  }
  if (type === "message" || item.role) {
    const role = String(item.role || "user").toLowerCase()
    const label =
      role === "assistant" ? "Assistant" : role === "system" || role === "developer" ? "System" : "User"
    return `[${label}]: ${textFromContent(item.content ?? item.text)}`
  }
  return `[Event]: ${truncateText(safeString(item), TOOL_OUTPUT_MAX_CHARS)}`
}

export function serializeCompactInput(input: unknown) {
  const items = Array.isArray(input) ? input : [input]
  return items
    .map(serializeResponsesItem)
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n\n")
}

function splitContext(serialized: string) {
  if (serialized.length <= MAX_CONTEXT_CHARS) return serialized
  const recent = serialized.slice(-RECENT_CONTEXT_CHARS)
  const headBudget = Math.max(0, MAX_CONTEXT_CHARS - recent.length)
  return `${serialized.slice(0, headBudget)}\n\n[older context truncated]\n\n${recent}`
}

export function buildCompactSummaryPrompt(input: unknown) {
  const context = splitContext(serializeCompactInput(input))
  return [
    "请根据下面的会话历史生成一份用于继续对话的压缩上下文。",
    "要求：",
    "- 用中文输出，除非路径、命令、错误文本、代码标识本身是英文。",
    "- 保留用户目标、约束、已完成工作、正在进行的工作、阻塞点、关键决策、下一步、重要文件/命令/错误。",
    "- 工具调用和工具结果只能作为事实摘要，不要保留 provider-native 工具结构。",
    "- 不要解释你在做压缩，也不要加入与原会话无关的新建议。",
    "",
    "请严格使用以下 Markdown 结构：",
    "## Goal",
    "- ...",
    "",
    "## Constraints & Preferences",
    "- ...",
    "",
    "## Progress",
    "### Done",
    "- ...",
    "### In Progress",
    "- ...",
    "### Blocked",
    "- ...",
    "",
    "## Key Decisions",
    "- ...",
    "",
    "## Next Steps",
    "- ...",
    "",
    "## Critical Context",
    "- ...",
    "",
    "## Relevant Files",
    "- ...",
    "",
    "<conversation>",
    context || "[empty]",
    "</conversation>",
  ].join("\n")
}

export function buildCompactSummaryRequest(body: AnyRecord, modelId: string) {
  return {
    model: modelId,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildCompactSummaryPrompt(body.input),
          },
        ],
      },
    ],
    stream: false,
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    max_output_tokens: SUMMARY_OUTPUT_TOKENS,
  }
}

export function buildLocalResponsesCompaction(summary: string, usage?: TokenUsage) {
  const text = summary.trim() || "## Goal\n- (none)"
  return {
    id: responseId("resp_compact"),
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output: [
      {
        id: responseId("msg"),
        type: "message",
        status: "completed",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `<conversation-checkpoint>\n${text}\n</conversation-checkpoint>`,
          },
        ],
      },
    ],
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
      total_tokens: usage?.totalTokens ?? 0,
    },
  }
}
