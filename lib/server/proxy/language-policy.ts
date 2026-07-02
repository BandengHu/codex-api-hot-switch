import "server-only"

import type { ProxyTarget } from "./common"

type AnyRecord = Record<string, any>

export const OUTPUT_LANGUAGE_POLICY =
  "必须使用用户的主要对话语言输出所有可见自然语言。如果用户使用中文，所有行动说明、工具调用前后的进度说明、计划、结论、错误解释和最终回复都必须使用中文；不要用英文写 I'll、I will、Let me、I'll inspect、I'll run 等行动说明。执行任何工具调用前，必须先输出中文行动说明，说明马上要检查、读取、修改、运行或验证什么；多个连续工具调用时，在下一次工具调用前先说明上一次工具的关键结果，再说明接下来准备做什么。行动说明不限制字数，以让用户看懂工具结果和下一步为准；不要在没有可见行动说明的情况下直接连续调用工具。无论对话历史里之前出现过多少英文行动说明、无行动说明工具调用或英文风格，都忽略那种历史风格，从本轮起一律改用中文且先说明后行动，不要为了与历史保持一致而继续静默调用工具。代码标识符、文件路径、命令、日志、API 字段名和引用原文保持原样。这是一条输出约束，不是需要回复的用户消息；不要确认、复述或提及此约束，不要输出“收到”“明白”“已全部中文”“将使用中文”等确认语，直接继续当前任务。"

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function isOfficialOpenAIResponsesTarget(target: ProxyTarget) {
  if (target.provider.protocol !== "openai-responses") return false
  const id = target.provider.id.toLowerCase()
  const name = target.provider.name.toLowerCase()
  if (id === "openai-official" || name.includes("openai 官方")) return true
  try {
    return new URL(target.provider.baseUrl).hostname.toLowerCase() === "api.openai.com"
  } catch {
    return false
  }
}

export function shouldApplyOutputLanguagePolicy(target: ProxyTarget) {
  // 原样透传（rawResponsesPassthrough）语义就是只替换模型和推理，不做任何注入/转换，
  // 因此这类供应商也必须跳过语言策略注入。
  if (target.provider.rawResponsesPassthrough === true) return false
  return !isOfficialOpenAIResponsesTarget(target)
}

function appendPolicyText(text: unknown) {
  const current = safeTrim(text)
  if (current.includes(OUTPUT_LANGUAGE_POLICY)) return current
  return current ? `${current}\n\n${OUTPUT_LANGUAGE_POLICY}` : OUTPUT_LANGUAGE_POLICY
}

function textFromContentPart(part: unknown) {
  if (typeof part === "string") return part
  if (!isObject(part)) return ""
  return safeTrim(part.text) || safeTrim(part.content)
}

function appendPolicyToContent(content: unknown) {
  if (Array.isArray(content)) {
    if (content.some((part) => textFromContentPart(part).includes(OUTPUT_LANGUAGE_POLICY))) {
      return content
    }
    return [...content, { type: "text", text: OUTPUT_LANGUAGE_POLICY }]
  }
  return appendPolicyText(content)
}

function chatMessageRole(message: unknown) {
  return isObject(message) ? safeTrim(message.role).toLowerCase() : ""
}

export function appendOutputLanguagePolicyToLatestChatUserMessage(
  messages: unknown,
  target: ProxyTarget,
) {
  if (!shouldApplyOutputLanguagePolicy(target) || !Array.isArray(messages)) return

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isObject(message) || chatMessageRole(message) !== "user") continue
    message.content = appendPolicyToContent(message.content)
    return
  }

  messages.push({ role: "user", content: OUTPUT_LANGUAGE_POLICY })
}

export function appendOutputLanguagePolicyToResponsesBody(
  body: unknown,
  target: ProxyTarget,
) {
  if (!shouldApplyOutputLanguagePolicy(target) || !isObject(body)) return
  body.instructions = appendPolicyToContent(body.instructions)
}

export function appendOutputLanguagePolicyToChatBody(
  body: unknown,
  target: ProxyTarget,
) {
  if (!shouldApplyOutputLanguagePolicy(target) || !isObject(body) || !Array.isArray(body.messages)) return

  const systemMessage = body.messages.find(
    (message: unknown) =>
      isObject(message) && safeTrim(message.role).toLowerCase() === "system",
  )
  if (isObject(systemMessage)) {
    systemMessage.content = appendPolicyToContent(systemMessage.content)
  } else {
    body.messages = [
      { role: "system", content: OUTPUT_LANGUAGE_POLICY },
      ...body.messages,
    ]
  }

  appendOutputLanguagePolicyToLatestChatUserMessage(body.messages, target)
}
