import "server-only"

type AnyRecord = Record<string, any>

const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "propertyOrdering",
  "default",
  "minimum",
  "maximum",
  "properties",
  "items",
  "anyOf",
])

const JSON_SCHEMA_ONLY_KEYS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "unevaluatedProperties",
  "patternProperties",
  "oneOf",
  "allOf",
  "const",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "contains",
  "minContains",
  "maxContains",
  "prefixItems",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "examples",
])

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema)
  if (!isObject(value)) return value

  const out: AnyRecord = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "$id") continue
    out[key] = normalizeJsonSchema(child)
  }
  return out
}

function ensureObjectSchema(value: unknown): unknown {
  if (!isObject(value)) return value
  const out = { ...value }
  out.type ??= "object"
  if (out.type === "object") out.properties ??= {}
  return out
}

function requiresJsonSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(requiresJsonSchema)
  if (!isObject(value)) return false

  for (const [key, child] of Object.entries(value)) {
    if (JSON_SCHEMA_ONLY_KEYS.has(key)) return true
    if (!GEMINI_SCHEMA_KEYS.has(key)) return true
    if (key === "type" && Array.isArray(child)) return true
    if (key === "properties") {
      if (!isObject(child)) return true
      if (Object.values(child).some(requiresJsonSchema)) return true
    } else if (key === "items") {
      if (!isObject(child) || requiresJsonSchema(child)) return true
    } else if (key === "anyOf") {
      if (!Array.isArray(child) || child.some(requiresJsonSchema)) return true
    } else if (requiresJsonSchema(child)) {
      return true
    }
  }

  return false
}

function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema)
  if (!isObject(value)) return value

  const out: AnyRecord = {}
  for (const [key, child] of Object.entries(value)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue
    if (key === "properties" && isObject(child)) {
      out.properties = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [name, toGeminiSchema(schema)]),
      )
    } else if (key === "items" && isObject(child)) {
      out.items = toGeminiSchema(child)
    } else if (key === "anyOf" && Array.isArray(child)) {
      out.anyOf = child.map(toGeminiSchema)
    } else {
      out[key] = child
    }
  }
  return out
}

export function geminiFunctionDeclaration(params: {
  name: string
  description: string
  parameters: unknown
}) {
  const schema = ensureObjectSchema(normalizeJsonSchema(params.parameters))
  const declaration: AnyRecord = {
    name: params.name,
    description: params.description || "",
  }

  if (requiresJsonSchema(schema)) {
    declaration.parametersJsonSchema = schema
  } else {
    declaration.parameters = toGeminiSchema(schema)
  }

  return declaration
}
