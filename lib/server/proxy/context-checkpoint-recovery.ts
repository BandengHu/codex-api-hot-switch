type AnyRecord = Record<string, any>

const CODEX_HANDOFF_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process."
const LOCAL_CHECKPOINT_PREFIX = "<conversation-checkpoint>"

export const CONTEXT_CHECKPOINT_HEADING =
  "The following is the compacted conversation context from an earlier turn:"
export const CONTEXT_CHECKPOINT_CONTINUE_PROMPT =
  "请根据上述压缩后的会话状态，直接继续尚未完成的当前任务。"

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (typeof part === "string") return part
      if (!isObject(part)) return ""
      if (typeof part.text === "string") return part.text
      if (typeof part.content === "string") return part.content
      return ""
    })
    .join("")
}

function isCheckpointMessage(item: unknown) {
  if (!isObject(item) || item.role !== "user") return false
  if (item.type != null && item.type !== "message") return false
  const text = contentText(item.content).trimStart()
  return text.startsWith(CODEX_HANDOFF_PREFIX) || text.startsWith(LOCAL_CHECKPOINT_PREFIX)
}

export function isContextCheckpointRecovery(input: unknown) {
  if (typeof input === "string") {
    const text = input.trimStart()
    return text.startsWith(CODEX_HANDOFF_PREFIX) || text.startsWith(LOCAL_CHECKPOINT_PREFIX)
  }
  return Array.isArray(input) && input.some(isCheckpointMessage)
}

function isPersistentUserInstruction(message: AnyRecord) {
  if (message.role !== "user") return false
  const text = contentText(message.content).trimStart()
  return /^#\s*AGENTS\.md instructions\b/iu.test(text) || text.startsWith("<INSTRUCTIONS>")
}

export function normalizeContextCheckpointRecoveryMessages(messages: AnyRecord[]) {
  let checkpointIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isCheckpointMessage(messages[index])) {
      checkpointIndex = index
      break
    }
  }
  if (checkpointIndex < 0) return messages

  const retained: AnyRecord[] = []
  for (let index = 0; index < checkpointIndex; index += 1) {
    const message = messages[index]
    if (!isObject(message)) continue
    if (message.role === "system" || message.role === "developer") {
      retained.push(message)
      continue
    }
    if (isPersistentUserInstruction(message)) {
      retained.push({ ...message, role: "system" })
    }
  }
  const checkpointText = contentText(messages[checkpointIndex]?.content).trim()
  retained.push({
    role: "assistant",
    content: `${CONTEXT_CHECKPOINT_HEADING}\n\n${checkpointText}`,
  })
  const following = messages.slice(checkpointIndex + 1)
  retained.push(...following)
  if (!following.some((message) => isObject(message) && message.role === "user")) {
    retained.push({
      role: "user",
      content: CONTEXT_CHECKPOINT_CONTINUE_PROMPT,
    })
  }
  return retained
}
