import "server-only"

type AnyRecord = Record<string, any>

const SCHEMA_NAME_MAP_KEYS = new Set([
  "$defs",
  "definitions",
  "patternProperties",
  "properties",
])

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export interface BodyFilterResult<T = unknown> {
  body: T
  removedKeys: string[]
}

export function filterPrivateParams<T>(
  body: T,
  whitelist: string[] = [],
): BodyFilterResult<T> {
  const allowed = new Set(whitelist)
  const removedKeys: string[] = []

  const walk = (value: unknown, path: string[]): { value: unknown; changed: boolean } => {
    if (Array.isArray(value)) {
      let changed = false
      const next = value.map((item) => {
        const result = walk(item, path)
        changed = changed || result.changed
        return result.value
      })
      return changed ? { value: next, changed } : { value, changed: false }
    }
    if (!isObject(value)) return { value, changed: false }

    const isSchemaNameMap = SCHEMA_NAME_MAP_KEYS.has(path.at(-1) || "")
    let changed = false
    const next: AnyRecord = {}
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith("_") && !allowed.has(key) && !isSchemaNameMap) {
        removedKeys.push([...path, key].join(".") || key)
        changed = true
        continue
      }
      const result = walk(child, [...path, key])
      changed = changed || result.changed
      next[key] = result.value
    }
    return changed ? { value: next, changed } : { value, changed: false }
  }

  const result = walk(body, [])
  return {
    body: result.value as T,
    removedKeys,
  }
}
