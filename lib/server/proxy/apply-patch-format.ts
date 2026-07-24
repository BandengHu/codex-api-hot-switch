/**
 * apply_patch conversion for non-passthrough protocol paths.
 *
 * Upstream models see OpenCode-style structured edit/write fields.
 * Relay rebuilds Codex freeform apply_patch text for the desktop executor.
 * Raw Responses passthrough must not use this module for tool rewriting.
 */

export type PatchAction = "add_file" | "delete_file" | "update_file" | "replace_file" | "batch"

type AnyRecord = Record<string, any>

function isObject(value: unknown): value is AnyRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function asString(value: unknown) {
  return typeof value === "string" ? value : ""
}

export const APPLY_PATCH_STRUCTURED_DESCRIPTION = [
  "Edit files for Codex apply_patch.",
  "Prefer OpenCode-style structured fields: path + old_string + new_string for exact replace, or path + content for full-file write.",
  "You may batch multiple edits in `edits`.",
  "Fallback: freeform patch text in `input` or `patchText` (common header mistakes are auto-normalized).",
  "Do not use shell redirects to write files when this tool is available.",
].join(" ")

export const APPLY_PATCH_STRUCTURED_EXAMPLE = [
  "Preferred exact edit (OpenCode edit style):",
  JSON.stringify(
    {
      path: "src/example.ts",
      old_string: "const value = 1",
      new_string: "const value = 2",
    },
    null,
    2,
  ),
  "",
  "Preferred full write (OpenCode write style):",
  JSON.stringify(
    {
      path: "src/new.ts",
      content: "export const ok = true\n",
    },
    null,
    2,
  ),
  "",
  "Batch:",
  JSON.stringify(
    {
      edits: [
        { path: "a.txt", content: "hello\n" },
        { path: "b.ts", old_string: "foo", new_string: "bar" },
      ],
    },
    null,
    2,
  ),
].join("\n")

export const APPLY_PATCH_FUNCTION_DESCRIPTION = [
  APPLY_PATCH_STRUCTURED_DESCRIPTION,
  APPLY_PATCH_STRUCTURED_EXAMPLE,
].join("\n\n")

export const APPLY_PATCH_BASE_DESCRIPTION = APPLY_PATCH_STRUCTURED_DESCRIPTION
export const APPLY_PATCH_EXAMPLE = APPLY_PATCH_STRUCTURED_EXAMPLE

export const APPLY_PATCH_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: {
      type: "string",
      description: "Target file path for a single edit/write.",
    },
    old_string: {
      type: "string",
      description: "Exact text to replace (OpenCode edit style). Omit for full-file write.",
    },
    new_string: {
      type: "string",
      description: "Replacement text for old_string. Must differ from old_string.",
    },
    oldString: {
      type: "string",
      description: "Alias of old_string.",
    },
    newString: {
      type: "string",
      description: "Alias of new_string.",
    },
    content: {
      type: "string",
      description: "Full file content for write/create (OpenCode write style).",
    },
    replace_all: {
      type: "boolean",
      description: "Replace all exact occurrences when using old_string/new_string. Best effort for apply_patch conversion.",
    },
    replaceAll: {
      type: "boolean",
      description: "Alias of replace_all.",
    },
    edits: {
      type: "array",
      description: "Batch of OpenCode-style edit/write operations.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" },
          content: { type: "string" },
          replace_all: { type: "boolean" },
          replaceAll: { type: "boolean" },
        },
        required: ["path"],
      },
    },
    operations: {
      type: "array",
      description: "Low-level structured operations (optional advanced form).",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          type: {
            type: "string",
            enum: ["add_file", "update_file", "delete_file", "replace_file"],
          },
          path: { type: "string" },
          content: { type: "string" },
          move_to: { type: "string" },
          hunks: { type: "array" },
        },
      },
    },
    input: {
      type: "string",
      description: "Fallback freeform apply_patch text.",
    },
    patchText: {
      type: "string",
      description: "OpenCode apply_patch alias for freeform patch text.",
    },
    patch_text: {
      type: "string",
      description: "Alias of patchText.",
    },
  },
} as const

export function normalizeApplyPatchText(text: string) {
  let value = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
  if (!value.trim()) return ""

  const lines = value.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\*\*\*\s*Begin\s+Patch\b/i.test(line)) {
      lines[index] = "*** Begin Patch"
      continue
    }
    if (/^\*\*\*\s*End\s+Patch\b/i.test(line)) {
      lines[index] = "*** End Patch"
    }
  }
  value = lines.join("\n").trim()

  const looksLikePatch =
    /^\*\*\*\s*Begin\s+Patch/i.test(value) ||
    /^\*\*\*\s+(Add|Update|Delete)\s+File:/im.test(value)
  if (looksLikePatch) {
    if (!/^\*\*\* Begin Patch$/m.test(value)) {
      if (/^\*\*\*\s*Begin\s+Patch/im.test(value)) {
        value = value.replace(/^\*\*\*\s*Begin\s+Patch[^\n]*/im, "*** Begin Patch")
      } else {
        value = `*** Begin Patch\n${value}`
      }
    }
    if (!/^\*\*\* End Patch\s*$/m.test(value)) {
      value = `${value.replace(/\s*$/, "")}\n*** End Patch`
    }
  }

  return `${value.replace(/\n{3,}/g, "\n\n").trim()}\n`
}

function splitLinesPreserveEnd(text: string) {
  return String(text).replace(/\r\n/g, "\n").split("\n")
}

export function buildApplyPatchText(operations: AnyRecord[]) {
  let text = "*** Begin Patch"
  for (const operation of operations) {
    const path = safeTrim(operation.path)
    if (!path) continue
    if (operation.type === "add_file") {
      text += `\n*** Add File: ${path}`
      for (const line of splitLinesPreserveEnd(String(operation.content ?? ""))) text += `\n+${line}`
    } else if (operation.type === "delete_file") {
      text += `\n*** Delete File: ${path}`
    } else if (operation.type === "update_file") {
      text += `\n*** Update File: ${path}`
      if (operation.move_to) text += `\n*** Move to: ${safeTrim(operation.move_to)}`
      const hunks = Array.isArray(operation.hunks) ? operation.hunks : []
      if (!hunks.length) text += "\n@@"
      for (const hunk of hunks) {
        text += safeTrim(hunk?.context) ? `\n@@ ${safeTrim(hunk.context)}` : "\n@@"
        for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
          const rawText = String(line?.text ?? "")
          if (rawText.startsWith("+") || rawText.startsWith("-") || rawText.startsWith(" ")) {
            text += `\n${rawText}`
            continue
          }
          const op = line?.op === "add" ? "+" : line?.op === "remove" ? "-" : " "
          text += `\n${op}${rawText}`
        }
      }
    } else if (operation.type === "replace_file") {
      text += `\n*** Delete File: ${path}`
      text += `\n*** Add File: ${path}`
      for (const line of splitLinesPreserveEnd(String(operation.content ?? ""))) text += `\n+${line}`
    }
  }
  return `${text}\n*** End Patch\n`
}

function openCodeEditToOperation(edit: AnyRecord): AnyRecord | null {
  const path = safeTrim(edit.path)
  if (!path) return null

  const oldString = asString(edit.old_string ?? edit.oldString)
  const newString = asString(edit.new_string ?? edit.newString)
  const content = asString(edit.content)
  const replaceAll = Boolean(edit.replace_all ?? edit.replaceAll)

  if (content && !oldString && !newString) {
    // Full write/create. replace_file covers both create and overwrite for Codex freeform.
    return { type: "replace_file", path, content }
  }

  if (oldString || newString) {
    if (oldString === newString) return null
    const removeLines = splitLinesPreserveEnd(oldString)
    const addLines = splitLinesPreserveEnd(newString)
    const hunk = {
      context: "",
      lines: [
        ...removeLines.map((text) => ({ op: "remove", text })),
        ...addLines.map((text) => ({ op: "add", text })),
      ],
    }
    // apply_patch freeform cannot natively express replace_all; emit one hunk.
    // Callers should pass unique old_string when possible.
    void replaceAll
    return {
      type: "update_file",
      path,
      hunks: [hunk],
    }
  }

  return null
}

function operationsFromOpenCodeValue(value: AnyRecord) {
  const out: AnyRecord[] = []
  if (Array.isArray(value.edits)) {
    for (const edit of value.edits) {
      if (!isObject(edit)) continue
      const op = openCodeEditToOperation(edit)
      if (op) out.push(op)
    }
  }
  const single = openCodeEditToOperation(value)
  if (single) out.push(single)
  return out
}

function operationsFromLowLevel(action: PatchAction | undefined, value: AnyRecord) {
  if (Array.isArray(value.operations) && value.operations.length) {
    return value.operations.filter(isObject)
  }
  if (action && action !== "batch" && safeTrim(value.path)) {
    return [{ ...value, type: action }]
  }
  if (safeTrim(value.type) && safeTrim(value.path)) {
    return [value]
  }
  return [] as AnyRecord[]
}

export function reconstructApplyPatchInput(action: PatchAction | undefined, args: string) {
  const trimmed = String(args || "").trim()
  if (!trimmed) return ""

  // Only treat as freeform when the payload itself is a patch, not JSON that embeds patch text.
  if (
    trimmed.startsWith("***") ||
    /^\*\*\*\s*Begin\s+Patch/i.test(trimmed) ||
    /^\*\*\*\s+(Add|Update|Delete)\s+File:/im.test(trimmed)
  ) {
    return normalizeApplyPatchText(trimmed)
  }

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return normalizeApplyPatchText(trimmed)
  }

  if (typeof value === "string") return normalizeApplyPatchText(value)
  if (!isObject(value)) return normalizeApplyPatchText(trimmed)

  // Freeform fields first so JSON wrappers are not mistaken for patch bodies.
  const raw = safeTrim(value.raw_patch || value.patch || value.input || value.patchText || value.patch_text)
  if (raw) return normalizeApplyPatchText(raw)

  const openCodeOps = operationsFromOpenCodeValue(value)
  if (openCodeOps.length) return buildApplyPatchText(openCodeOps)

  const lowLevel = operationsFromLowLevel(action, value)
  if (lowLevel.length) return buildApplyPatchText(lowLevel)

  return ""
}

export function buildApplyPatchFunctionToolDescription(sourceDescription = "") {
  const base = sourceDescription.trim()
  return base ? `${base}\n\n${APPLY_PATCH_FUNCTION_DESCRIPTION}` : APPLY_PATCH_FUNCTION_DESCRIPTION
}
