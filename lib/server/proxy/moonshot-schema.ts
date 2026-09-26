/**
 * 对齐 cc-switch #6863：Moonshot / Kimi Chat Completions 校验器按 pre-2019-09
 * JSON Schema 读取规则，拒绝带兄弟关键字的 `$ref`。Codex Desktop 的内建工具
 * schema 正是这种形状，导致所有路由到 Kimi 的桌面端请求被 400。
 *
 * 当上游 host 是 Moonshot/Kimi 时，把每个带兄弟关键字的 `$ref` 移进 `allOf`，
 * 兄弟关键字留在原地。其他供应商保持字节级不变的工具 schema。
 */

type AnyRecord = Record<string, any>

const MOONSHOT_HOST_SUFFIXES = ["moonshot.cn", "moonshot.ai", "kimi.com"]

const SINGLE_SCHEMA_KEYWORDS = new Set([
  "items",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
])

const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])

const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
])

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function upstreamRequiresRefSiblingAllOf(baseUrl: string): boolean {
  let host = ""
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host) return false
  return MOONSHOT_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  )
}

function moveRefIntoAllOf(map: AnyRecord) {
  const reference = map.$ref
  delete map.$ref
  const branch = { $ref: reference }
  if (Array.isArray(map.allOf)) {
    map.allOf.push(branch)
  } else {
    map.allOf = [branch]
  }
}

export function wrapRefSiblings(schema: unknown): number {
  if (!isObject(schema)) return 0
  let rewritten = 0
  if (Object.keys(schema).length > 1 && typeof schema.$ref === "string") {
    moveRefIntoAllOf(schema)
    rewritten += 1
  }
  for (const [key, child] of Object.entries(schema)) {
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      if (isObject(child)) {
        for (const entry of Object.values(child)) {
          rewritten += wrapRefSiblings(entry)
        }
      }
    } else if (SCHEMA_ARRAY_KEYWORDS.has(key)) {
      if (Array.isArray(child)) {
        for (const entry of child) {
          rewritten += wrapRefSiblings(entry)
        }
      }
    } else if (SINGLE_SCHEMA_KEYWORDS.has(key)) {
      if (Array.isArray(child)) {
        // Draft-07 tuple validation: `items` may be an array of schemas.
        for (const entry of child) {
          rewritten += wrapRefSiblings(entry)
        }
      } else {
        rewritten += wrapRefSiblings(child)
      }
    }
  }
  return rewritten
}

export function wrapRefSiblingsInChatTools(chatBody: AnyRecord): number {
  if (!Array.isArray(chatBody.tools)) return 0
  let changed = 0
  for (const tool of chatBody.tools) {
    if (!isObject(tool)) continue
    const parameters = tool.function?.parameters
    if (!isObject(parameters)) continue
    if (wrapRefSiblings(parameters) > 0) changed += 1
  }
  return changed
}
