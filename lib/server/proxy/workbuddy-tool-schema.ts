import "server-only"

type JsonRecord = Record<string, unknown>

const SCHEMA_TYPE_ALIASES: Record<string, string> = {
  str: "string",
  text: "string",
  int: "integer",
  bool: "boolean",
  dict: "object",
  list: "array",
  float: "number",
}

const VALID_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
])

const NUMERIC_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
] as const

const BOOLEAN_KEYWORDS = [
  "uniqueItems",
  "deprecated",
  "readOnly",
  "writeOnly",
] as const

const STRING_KEYWORDS = ["description", "title", "format", "pattern"] as const
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const
const SCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
] as const
const SCHEMA_SINGLE_KEYWORDS = [
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
] as const

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value !== "string") return undefined
  const number = Number(value.trim())
  return Number.isFinite(number) ? number : undefined
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === "true") return true
  if (normalized === "false") return false
  return undefined
}

function normalizeTypeKeyword(schema: JsonRecord) {
  const type = schema.type
  if (typeof type === "string") {
    const normalized = SCHEMA_TYPE_ALIASES[type.trim().toLowerCase()] ??
      type.trim().toLowerCase()
    if (VALID_SCHEMA_TYPES.has(normalized)) schema.type = normalized
    else if (isRecord(schema.properties)) schema.type = "object"
    else if (schema.items !== undefined) schema.type = "array"
    else delete schema.type
    return
  }
  if (Array.isArray(type)) {
    const normalized = type
      .filter((item): item is string => typeof item === "string")
      .map((item) => SCHEMA_TYPE_ALIASES[item.trim().toLowerCase()] ??
        item.trim().toLowerCase())
      .filter((item) => VALID_SCHEMA_TYPES.has(item))
    if (normalized.length > 0) schema.type = [...new Set(normalized)]
    else delete schema.type
  }
}

function normalizeObjectShape(schema: JsonRecord) {
  if (
    schema.type !== "object" &&
    schema.type !== undefined &&
    !isRecord(schema.properties)
  ) {
    return
  }
  if (schema.type === "object" || isRecord(schema.properties)) {
    schema.type = "object"
    if (!isRecord(schema.properties)) schema.properties = {}
  }
}

function normalizeRequired(schema: JsonRecord) {
  if (!Object.hasOwn(schema, "required")) return
  const required = schema.required
  if (Array.isArray(required)) {
    const values = required
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
    if (values.length > 0) schema.required = values
    else delete schema.required
    return
  }
  if (typeof required === "string" && required.trim()) {
    schema.required = [required.trim()]
    return
  }
  delete schema.required
}

function normalizeNestedSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    const first = value.find(isRecord)
    return first ? normalizeSchema(first) : { type: "string" }
  }
  return normalizeSchema(value)
}

function normalizeSchema(value: unknown): unknown {
  if (!isRecord(value)) return value
  const schema = value

  normalizeTypeKeyword(schema)
  normalizeObjectShape(schema)
  normalizeRequired(schema)

  if (Object.hasOwn(schema, "items")) {
    const items = schema.items
    if (items === null) delete schema.items
    else schema.items = normalizeNestedSchema(items)
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const map = schema[keyword]
    if (!isRecord(map)) continue
    for (const [key, child] of Object.entries(map)) {
      if (key === "dependencies" && Array.isArray(child)) continue
      map[key] = normalizeSchema(child)
    }
  }

  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const list = schema[keyword]
    if (!Array.isArray(list)) continue
    schema[keyword] = list.map((item) => normalizeSchema(item))
  }

  for (const keyword of SCHEMA_SINGLE_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue
    const child = schema[keyword]
    if (keyword === "items" && Array.isArray(child)) {
      schema[keyword] = normalizeNestedSchema(child)
    } else if (child !== null) {
      schema[keyword] = normalizeSchema(child)
    }
  }

  for (const keyword of NUMERIC_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue
    const number = coerceNumber(schema[keyword])
    if (number === undefined) delete schema[keyword]
    else schema[keyword] = number
  }

  for (const keyword of BOOLEAN_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue
    const flag = coerceBoolean(schema[keyword])
    if (flag === undefined) delete schema[keyword]
    else schema[keyword] = flag
  }

  for (const keyword of STRING_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue
    const text = schema[keyword]
    if (text === null || text === undefined) delete schema[keyword]
    else if (typeof text !== "string") schema[keyword] = String(text)
  }

  if (Object.hasOwn(schema, "additionalProperties")) {
    const additional = schema.additionalProperties
    if (isRecord(additional)) {
      schema.additionalProperties = normalizeSchema(additional)
    } else {
      const flag = coerceBoolean(additional)
      if (flag === undefined) delete schema.additionalProperties
      else schema.additionalProperties = flag
    }
  }

  if (Object.hasOwn(schema, "enum") && !Array.isArray(schema.enum)) {
    delete schema.enum
  }
  if (Object.hasOwn(schema, "examples") && !Array.isArray(schema.examples)) {
    delete schema.examples
  }
  for (const [key, child] of Object.entries(schema)) {
    if (child === null) delete schema[key]
  }
  return schema
}

function normalizeFunctionParameters(fn: JsonRecord) {
  const parameters = fn.parameters
  if (isRecord(parameters)) {
    const schema: JsonRecord = { ...parameters, type: "object" }
    if (!isRecord(schema.properties)) schema.properties = {}
    fn.parameters = normalizeSchema(schema)
  } else {
    fn.parameters = { type: "object", properties: {} }
  }
  if (fn.description !== undefined && typeof fn.description !== "string") {
    fn.description = String(fn.description)
  }
}

function normalizeFunctionTool(tool: unknown) {
  if (!isRecord(tool)) return
  if (isRecord(tool.function)) {
    normalizeFunctionParameters(tool.function)
    return
  }
  if (typeof tool.name === "string") {
    const parameters = tool.parameters
    if (isRecord(parameters)) {
      tool.parameters = normalizeSchema({
        ...parameters,
        type: "object",
        properties: isRecord(parameters.properties)
          ? parameters.properties
          : {},
      })
    } else {
      tool.parameters = { type: "object", properties: {} }
    }
    if (tool.description !== undefined && typeof tool.description !== "string") {
      tool.description = String(tool.description)
    }
  }
}

/** Repair only WorkBuddy Chat tool declarations before they reach the Go validator. */
export function normalizeWorkbuddyChatToolSchemas(body: unknown): number {
  if (!isRecord(body) || !Array.isArray(body.tools)) return 0
  let changed = 0
  for (const tool of body.tools) {
    if (!isRecord(tool) || tool.type !== "function") continue
    normalizeFunctionTool(tool)
    changed += 1
  }
  return changed
}
