import "server-only"

type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function canonicalJson(value: unknown): string {
  if (value == null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function canonicalToolArguments(value: unknown): string {
  if (typeof value === "string") {
    return canonicalToolArgumentsString(value)
  }
  if (value == null) return "{}"
  return isObject(value) ? canonicalJson(value) : canonicalJson({ input: value })
}

export function canonicalToolArgumentsString(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "{}"
  try {
    return canonicalJson(JSON.parse(trimmed))
  } catch {
    return value
  }
}
