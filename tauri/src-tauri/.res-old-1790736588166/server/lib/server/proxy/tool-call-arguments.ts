import "server-only"

import { canonicalJson } from "./json-canonical"

type AnyRecord = Record<string, unknown>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export class ToolCallArgumentsError extends Error {
  readonly code = "upstream_tool_arguments_invalid"

  constructor(message: string) {
    super(message)
    this.name = "ToolCallArgumentsError"
  }
}

export function repairFunctionCallArguments(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) return raw
  try {
    JSON.parse(raw)
    return raw
  } catch {
    // Some compatible shims prepend "{}" before the real function arguments.
  }
  const match = raw.match(/^\s*\{\s*\}\s*([\s\S]+)$/)
  if (!match) return raw
  const suffix = match[1].trimStart()
  try {
    JSON.parse(suffix)
    return suffix
  } catch {
    return raw
  }
}

function argumentsText(value: unknown) {
  if (typeof value === "string") return value.trim() ? value : "{}"
  if (value == null) return "{}"
  return canonicalJson(value)
}

export function normalizeToolCallArguments(
  value: unknown,
  options: {
    completed: boolean
    name?: string
    location?: string
  },
) {
  const raw = String(repairFunctionCallArguments(argumentsText(value)) || "{}")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    if (!options.completed) return { text: "{}", object: {} as AnyRecord }
    const label = options.name?.trim() || options.location?.trim() || "unknown"
    const detail = error instanceof Error ? error.message : String(error)
    throw new ToolCallArgumentsError(
      `上游已完成工具调用「${label}」，但 arguments 不是合法 JSON：${detail}`,
    )
  }

  if (!isObject(parsed)) {
    if (!options.completed) return { text: "{}", object: {} as AnyRecord }
    const label = options.name?.trim() || options.location?.trim() || "unknown"
    throw new ToolCallArgumentsError(
      `上游已完成工具调用「${label}」，但 arguments 必须是 JSON 对象`,
    )
  }

  return {
    text: canonicalJson(parsed),
    object: parsed,
  }
}
