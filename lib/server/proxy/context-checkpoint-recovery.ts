type AnyRecord = Record<string, any>

const CODEX_HANDOFF_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process."
const LOCAL_CHECKPOINT_PREFIX = "<conversation-checkpoint>"

export const CONTEXT_CHECKPOINT_RECOVERY_INSTRUCTION = [
  "这是一次上下文压缩后的恢复请求。",
  "最近一条包含交接摘要的用户消息替代了它之前的普通对话；更早的用户消息都是已处理历史，不能重新回答或重新执行。",
  "交接摘要之后的消息是压缩后新增的指令，必须按顺序处理，并以后发消息为准。",
  "如果最新用户消息是“继续”等续接指令，请直接从交接摘要中的当前主线、正在进行的工作或下一步继续。",
  "只有交接摘要明确标记为未完成的事项才可继续处理，不要复述这条恢复规则。",
].join("")

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
  retained.push(...messages.slice(checkpointIndex))
  retained.push({
    role: "system",
    content: CONTEXT_CHECKPOINT_RECOVERY_INSTRUCTION,
  })
  return retained
}
