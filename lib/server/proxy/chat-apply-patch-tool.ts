export const CHAT_APPLY_PATCH_TOOL_DESCRIPTION = [
  "Edit files using structured JSON arguments only.",
  "For one exact replacement, pass path, old_string, and new_string.",
  "Read the current file first: old_string must exactly match the current content.",
  "For a complete file create or overwrite, pass path and content.",
  "For multiple changes, pass edits containing the same structured fields.",
  "Every path is relative to the Codex task cwd; it does not inherit exec_command.workdir.",
  "If the repository is a child directory of the task cwd, include that directory prefix in path.",
  "Do not use shell redirection to write files when this tool is available.",
  'Exact replacement example: {"path":"repo/src/example.ts","old_string":"const value = 1","new_string":"const value = 2"}.',
  'Complete write example: {"path":"repo/src/new.ts","content":"export const ok = true\\n"}.',
  'Batch example: {"edits":[{"path":"repo/a.txt","content":"hello\\n"},{"path":"repo/b.ts","old_string":"foo","new_string":"bar"}]}.',
].join(" ")

const CHAT_APPLY_PATCH_EDIT_PROPERTIES = {
  path: {
    type: "string",
    description: "File path relative to the Codex task cwd.",
  },
  old_string: {
    type: "string",
    description: "Exact current text to replace.",
  },
  new_string: {
    type: "string",
    description: "Replacement text; it must differ from old_string.",
  },
  content: {
    type: "string",
    description: "Complete file content for a create or overwrite operation.",
  },
} as const

export const CHAT_APPLY_PATCH_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...CHAT_APPLY_PATCH_EDIT_PROPERTIES,
    edits: {
      type: "array",
      description: "Multiple structured file edits or complete writes.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: CHAT_APPLY_PATCH_EDIT_PROPERTIES,
        required: ["path"],
      },
    },
  },
} as const
