import "server-only"

type AnyRecord = Record<string, any>

export type AnthropicThinkingBlock =
  | {
      type: "thinking"
      thinking: string
      signature: string
    }
  | {
      type: "redacted_thinking"
      data: string
    }

const ENCODED_THINKING_PREFIX = "anthropic-thinking-v1:"

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function base64UrlEncode(text: string) {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

function base64UrlDecode(text: string) {
  const padded = `${text}${"=".repeat((4 - (text.length % 4)) % 4)}`
  return Buffer.from(padded.replaceAll("-", "+").replaceAll("_", "/"), "base64")
    .toString("utf8")
}

export function normalizeAnthropicThinkingBlock(
  value: unknown,
): AnthropicThinkingBlock | null {
  if (!isObject(value)) return null
  if (value.type === "thinking") {
    const signature = typeof value.signature === "string" ? value.signature : ""
    if (!signature) return null
    return {
      type: "thinking",
      thinking: typeof value.thinking === "string" ? value.thinking : "",
      signature,
    }
  }
  if (value.type === "redacted_thinking") {
    const data = typeof value.data === "string" ? value.data : ""
    if (!data) return null
    return { type: "redacted_thinking", data }
  }
  return null
}

export function encodeAnthropicThinkingBlocks(
  blocks: AnthropicThinkingBlock[],
): string | undefined {
  const normalized = blocks
    .map(normalizeAnthropicThinkingBlock)
    .filter((block): block is AnthropicThinkingBlock => Boolean(block))
  if (normalized.length === 0) return undefined
  return `${ENCODED_THINKING_PREFIX}${base64UrlEncode(JSON.stringify({ blocks: normalized }))}`
}

export function decodeAnthropicThinkingBlocks(value: unknown): AnthropicThinkingBlock[] {
  if (typeof value !== "string" || !value.startsWith(ENCODED_THINKING_PREFIX)) {
    return []
  }
  try {
    const parsed = JSON.parse(
      base64UrlDecode(value.slice(ENCODED_THINKING_PREFIX.length)),
    )
    if (!isObject(parsed) || !Array.isArray(parsed.blocks)) return []
    return parsed.blocks
      .map(normalizeAnthropicThinkingBlock)
      .filter((block): block is AnthropicThinkingBlock => Boolean(block))
  } catch {
    return []
  }
}
