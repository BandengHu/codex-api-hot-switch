import assert from "node:assert/strict"
import test from "node:test"
import {
  emptyToolContext,
  reconstructApplyPatchInput,
  responsesToolsToChatTools,
} from "./codex-tool-proxy"

test("Chat apply_patch exposes one unambiguous structured contract", () => {
  const sourceDescription = "This is a FREEFORM tool, so do not wrap the patch in JSON."
  const tools = responsesToolsToChatTools(
    [
      {
        type: "custom",
        name: "apply_patch",
        description: sourceDescription,
        format: {
          type: "grammar",
          syntax: "lark",
          definition: "start: begin_patch add_hunk end_patch",
        },
      },
    ],
    emptyToolContext(),
  )

  assert.equal(tools.length, 1)
  const tool = tools[0]?.function
  assert.equal(tool?.name, "apply_patch")
  assert.match(tool?.description, /structured JSON arguments only/)
  assert.match(tool?.description, /"old_string":"const value = 1"/)
  assert.match(tool?.description, /"edits":\[/)
  assert.match(tool?.description, /relative to the Codex task cwd/)
  assert.match(tool?.description, /does not inherit exec_command\.workdir/)
  assert.doesNotMatch(tool?.description, /FREEFORM/i)
  assert.doesNotMatch(tool?.description, /\*\*\* Begin Patch/)
  assert.doesNotMatch(tool?.description, /Original Codex custom tool metadata/)
  assert.doesNotMatch(tool?.description, /begin_patch|add_hunk|end_patch/)

  const properties = tool?.parameters?.properties
  assert.deepEqual(Object.keys(properties).sort(), [
    "content",
    "edits",
    "new_string",
    "old_string",
    "path",
  ])
  for (const hidden of [
    "input",
    "patchText",
    "patch_text",
    "operations",
    "oldString",
    "newString",
  ]) {
    assert.equal(hidden in properties, false)
  }

  assert.deepEqual(Object.keys(properties.edits.items.properties).sort(), [
    "content",
    "new_string",
    "old_string",
    "path",
  ])
})

test("structured Chat apply_patch arguments still reconstruct native patch text", () => {
  const patch = reconstructApplyPatchInput(
    "batch",
    JSON.stringify({
      path: "codex-api-hot-switch/src/example.ts",
      old_string: "const value = 1",
      new_string: "const value = 2",
    }),
  )

  assert.match(patch, /^\*\*\* Begin Patch\n/)
  assert.match(patch, /\*\*\* Update File: codex-api-hot-switch\/src\/example\.ts\n/)
  assert.match(patch, /-const value = 1\n/)
  assert.match(patch, /\+const value = 2\n/)
  assert.match(patch, /\*\*\* End Patch\n$/)
})
