import "server-only"

import { isWorkbuddyProvider } from "@/lib/workbuddy-provider"
import type { ProxyTarget } from "./common"

const DSH_IDENTITY = "You are an AI agent powered by DeepSeek Harness."
const DSH_GUI_IDENTITY =
  "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names."
const DSH_PATH_REFERENCE = "Tokens prefixed with @ are paths the user explicitly referenced."
const WORKBUDDY_PATH_REFERENCE =
  "References beginning with @ identify paths explicitly mentioned by the user."
const CODEX_OPEN_SOURCE_IDENTITY =
  "Codex CLI is an open source project led by OpenAI."
const WORKBUDDY_CODEX_IDENTITY =
  "Codex is a terminal-based coding assistant intended for precise, safe, and helpful work."
const CODEX_AGENT_PREFIX =
  "You are a coding agent running in the Codex CLI, a terminal-based coding assistant."

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function normalizeDshInstructions(content: unknown): unknown {
  if (typeof content === "string") {
    const text = content.startsWith(DSH_IDENTITY) ? content.slice(DSH_IDENTITY.length) : content
    const identityOffset = CODEX_AGENT_PREFIX.length + 1
    const hasCodexIdentity =
      text.startsWith(CODEX_AGENT_PREFIX) &&
      text.slice(identityOffset, identityOffset + CODEX_OPEN_SOURCE_IDENTITY.length) ===
        CODEX_OPEN_SOURCE_IDENTITY
    const normalized = hasCodexIdentity
      ? `${CODEX_AGENT_PREFIX} ${WORKBUDDY_CODEX_IDENTITY}${text.slice(identityOffset + CODEX_OPEN_SOURCE_IDENTITY.length)}`
      : text
    return normalized
      .replace(DSH_GUI_IDENTITY, "")
      .replace(DSH_PATH_REFERENCE, WORKBUDDY_PATH_REFERENCE)
  }
  if (!Array.isArray(content) || content.length === 0) return content
  const first = content[0]
  if (typeof first === "string") {
    const text = normalizeDshInstructions(first)
    return text === first ? content : [text, ...content.slice(1)]
  }
  if (
    isObject(first) &&
    (first.type === "text" || first.type === "input_text") &&
    typeof first.text === "string"
  ) {
    const text = normalizeDshInstructions(first.text)
    return text === first.text ? content : [{ ...first, text }, ...content.slice(1)]
  }
  return content
}

export function normalizeWorkbuddyChatMessages(
  body: { messages?: unknown },
  target: Pick<ProxyTarget, "provider">,
) {
  if (
    !isWorkbuddyProvider(target.provider) ||
    target.provider.rawResponsesPassthrough === true ||
    !Array.isArray(body.messages)
  ) return

  body.messages = body.messages.map((message: unknown) => {
    if (!isObject(message) || typeof message.role !== "string") return message
    const role = message.role.trim().toLowerCase()
    if (role !== "system" && role !== "developer") return message

    // Apply only instruction changes verified against WorkBuddy's 11128 rejection.
    const content = normalizeDshInstructions(message.content)
    const nextRole = role === "developer" ? "system" : message.role
    if (content === message.content && nextRole === message.role) return message
    return { ...message, role: nextRole, content }
  })
}
