import "server-only"

type AnyRecord = Record<string, any>

export interface GeminiToolSchemaHint {
  expectedKeys: string[]
  requiredKeys: string[]
}

export type GeminiToolSchemaHints = Record<string, GeminiToolSchemaHint>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : []
}

export function buildGeminiToolSchemaHints(
  tools: Array<{ name: string; parameters: unknown }>,
): GeminiToolSchemaHints {
  const hints: GeminiToolSchemaHints = {}
  for (const tool of tools) {
    if (!tool.name || !isObject(tool.parameters)) continue
    const properties = isObject(tool.parameters.properties)
      ? tool.parameters.properties
      : {}
    const expectedKeys = Object.keys(properties)
    if (expectedKeys.length === 0) continue
    hints[tool.name] = {
      expectedKeys,
      requiredKeys: stringArray(tool.parameters.required),
    }
  }
  return hints
}

export function rectifyGeminiToolCallArgs(
  toolName: string,
  args: unknown,
  hints: GeminiToolSchemaHints | undefined,
) {
  const hint = hints?.[toolName]
  if (!hint || hint.expectedKeys.length === 0 || !isObject(args)) return args
  const entries = Object.entries(args)
  if (entries.length === 0) return args

  const out: AnyRecord = { ...args }
  let changed = false

  if (hint.expectedKeys.includes("skill") && !Object.hasOwn(out, "skill")) {
    if (Object.hasOwn(out, "name")) {
      out.skill = out.name
      delete out.name
      changed = true
    }
  }

  if (!hint.expectedKeys.includes("parameters") && isObject(out.parameters)) {
    const extracted: Array<[string, unknown]> = []
    for (const expectedKey of hint.expectedKeys) {
      if (Object.hasOwn(out, expectedKey)) continue
      if (!Object.hasOwn(out.parameters, expectedKey)) continue
      const value = out.parameters[expectedKey]
      extracted.push([
        expectedKey,
        Array.isArray(value) && value.length === 1 ? value[0] : value,
      ])
    }
    if (extracted.length > 0) {
      for (const [key, value] of extracted) out[key] = value
      delete out.parameters
      changed = true
    }
  }

  if (hint.requiredKeys.every((key) => Object.hasOwn(out, key))) {
    return changed ? out : args
  }

  const expectedKeySet = new Set(hint.expectedKeys)
  const unexpectedKeys = Object.keys(out).filter((key) => !expectedKeySet.has(key))
  if (unexpectedKeys.length !== 1) return changed ? out : args

  const targetKey =
    hint.requiredKeys.find((key) => !Object.hasOwn(out, key)) ||
    (hint.expectedKeys.length === 1 && Object.keys(out).length === 1
      ? hint.expectedKeys[0]
      : "")
  if (!targetKey || Object.hasOwn(out, targetKey)) return changed ? out : args

  const sourceKey = unexpectedKeys[0]
  out[targetKey] = out[sourceKey]
  delete out[sourceKey]
  return out
}
