type AnyRecord = Record<string, any>

const ANTHROPIC_MAX_PROMPT_CACHE_BREAKPOINTS = 4

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function isClaudeAnthropicBody(body: AnyRecord) {
  return safeTrim(body.model).toLowerCase().includes("claude")
}

export function countAnthropicPromptCacheBreakpoints(
  value: unknown,
  seen = new WeakSet<object>(),
): number {
  if (!value || typeof value !== "object") return 0
  if (seen.has(value)) return 0
  seen.add(value)

  let count = isObject(value) && value.cache_control != null ? 1 : 0
  for (const child of Object.values(value)) {
    count += countAnthropicPromptCacheBreakpoints(child, seen)
  }
  return count
}

function lastCacheableBlock(blocks: unknown) {
  if (!Array.isArray(blocks)) return null
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (!isObject(block)) continue
    const type = safeTrim(block.type)
    if (type === "thinking" || type === "redacted_thinking") continue
    return block
  }
  return null
}

function setPromptCacheBreakpoint(block: AnyRecord | null, consume: () => boolean) {
  if (!block || block.cache_control != null || !consume()) return false
  block.cache_control = { type: "ephemeral" }
  return true
}

function setMessageBreakpoint(message: unknown, consume: () => boolean) {
  if (!isObject(message)) return false
  return setPromptCacheBreakpoint(lastCacheableBlock(message.content), consume)
}

export function applyAnthropicPromptCaching(body: AnyRecord) {
  if (!isClaudeAnthropicBody(body)) return

  const existingBreakpoints = countAnthropicPromptCacheBreakpoints(body)
  if (existingBreakpoints > ANTHROPIC_MAX_PROMPT_CACHE_BREAKPOINTS) {
    console.warn(
      `[anthropic-cache] 调用方已有 ${existingBreakpoints} 个 cache_control 断点，超过 Anthropic 支持的 ${ANTHROPIC_MAX_PROMPT_CACHE_BREAKPOINTS} 个；保留原始断点并停止自动注入`,
    )
  }

  let remaining = ANTHROPIC_MAX_PROMPT_CACHE_BREAKPOINTS - existingBreakpoints
  if (remaining <= 0) return

  const consume = () => {
    if (remaining <= 0) return false
    remaining -= 1
    return true
  }

  setPromptCacheBreakpoint(lastCacheableBlock(body.tools), consume)
  setPromptCacheBreakpoint(lastCacheableBlock(body.system), consume)

  if (!Array.isArray(body.messages) || remaining <= 0) return

  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    if (setMessageBreakpoint(body.messages[index], consume)) break
  }

  if (remaining <= 0 || body.messages.length < 4) return

  let reverseUserCount = 0
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index]
    if (!isObject(message) || safeTrim(message.role) !== "user") continue
    reverseUserCount += 1
    if (reverseUserCount !== 2) continue
    setMessageBreakpoint(message, consume)
    break
  }
}
