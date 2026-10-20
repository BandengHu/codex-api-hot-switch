import "server-only"

import { isWorkbuddyProvider } from "@/lib/workbuddy-provider"
import type { ProxyTarget } from "./common"

const DSH_IDENTITY = "You are an AI agent powered by DeepSeek Harness."

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function stripDshIdentity(content: unknown): unknown {
  if (typeof content === "string") {
    return content.startsWith(DSH_IDENTITY) ? content.slice(DSH_IDENTITY.length) : content
  }
  if (!Array.isArray(content) || content.length === 0) return content
  const first = content[0]
  if (typeof first === "string") {
    const text = stripDshIdentity(first)
    return text === first ? content : [text, ...content.slice(1)]
  }
  if (
    isObject(first) &&
    (first.type === "text" || first.type === "input_text") &&
    typeof first.text === "string"
  ) {
    const text = stripDshIdentity(first.text)
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

    // Only this exact leading DSH identity reproduced WorkBuddy's 11128 rejection.
    const content = stripDshIdentity(message.content)
    const nextRole = role === "developer" ? "system" : message.role
    if (content === message.content && nextRole === message.role) return message
    return { ...message, role: nextRole, content }
  })
}
