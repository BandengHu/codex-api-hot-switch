import "server-only"

import { isWorkbuddyProvider } from "@/lib/workbuddy-provider"
import type { ProxyTarget } from "./common"

const DSH_IDENTITY = "You are an AI agent powered by DeepSeek Harness."
const DSH_GUI_IDENTITY =
  "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names."
const DSH_PATH_REFERENCE = "Tokens prefixed with @ are paths the user explicitly referenced."
const WORKBUDDY_PATH_REFERENCE =
  "References beginning with @ identify paths explicitly mentioned by the user."

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function normalizeDshInstructions(content: unknown): unknown {
  if (typeof content === "string") {
    const text = content.startsWith(DSH_IDENTITY) ? content.slice(DSH_IDENTITY.length) : content
    return text
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

    // Apply only the exact DSH instruction changes verified against WorkBuddy's 11128 rejection.
    const content = normalizeDshInstructions(message.content)
    const nextRole = role === "developer" ? "system" : message.role
    if (content === message.content && nextRole === message.role) return message
    return { ...message, role: nextRole, content }
  })
}
