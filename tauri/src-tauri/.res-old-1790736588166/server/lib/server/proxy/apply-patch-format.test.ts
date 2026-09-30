import assert from "node:assert/strict"
import test from "node:test"
import {
  APPLY_PATCH_PARAMETERS,
  buildApplyPatchText,
  normalizeApplyPatchText,
  reconstructApplyPatchInput,
} from "./apply-patch-format"

test("normalize fixes Begin/End Patch trailing stars", () => {
  const raw = [
    "*** Begin Patch ***",
    "*** Add File: a.txt",
    "+ok",
    "*** End Patch ***",
  ].join("\n")
  const out = normalizeApplyPatchText(raw)
  assert.equal(out.startsWith("*** Begin Patch\n"), true)
  assert.match(out, /\*\*\* End Patch\n$/)
  assert.equal(out.includes("*** Begin Patch ***"), false)
})

test("OpenCode edit style becomes update freeform", () => {
  const out = reconstructApplyPatchInput(
    "batch",
    JSON.stringify({
      path: "src/a.ts",
      old_string: "const x = 1",
      new_string: "const x = 2",
    }),
  )
  assert.match(out, /^\*\*\* Begin Patch\n/)
  assert.match(out, /\*\*\* Update File: src\/a\.ts\n/)
  assert.match(out, /-const x = 1\n/)
  assert.match(out, /\+const x = 2\n/)
  assert.match(out, /\*\*\* End Patch\n$/)
})

test("OpenCode write style becomes create-or-overwrite freeform", () => {
  const out = reconstructApplyPatchInput(
    "batch",
    JSON.stringify({
      path: "src/new.ts",
      content: "export const ok = true\n",
    }),
  )
  assert.match(out, /\*\*\* Add File: src\/new\.ts\n/)
  assert.match(out, /\+export const ok = true\n/)
  assert.equal(out.includes("*** Delete File:"), false)
})

test("OpenCode write style can create or clear an empty file", () => {
  const out = reconstructApplyPatchInput(
    "batch",
    JSON.stringify({
      path: "src/empty.txt",
      content: "",
    }),
  )
  assert.match(out, /\*\*\* Add File: src\/empty\.txt\n/)
  assert.match(out, /\n\+\n\*\*\* End Patch\n$/)
})

test("unsupported replace_all fields are not advertised", () => {
  assert.equal("replace_all" in APPLY_PATCH_PARAMETERS.properties, false)
  assert.equal("replaceAll" in APPLY_PATCH_PARAMETERS.properties, false)
})

test("OpenCode edits batch and patchText fallback work", () => {
  const batch = reconstructApplyPatchInput(
    "batch",
    JSON.stringify({
      edits: [
        { path: "a.txt", content: "hello" },
        { path: "b.ts", oldString: "foo", newString: "bar" },
      ],
    }),
  )
  assert.match(batch, /\*\*\* Add File: a\.txt\n/)
  assert.match(batch, /\*\*\* Update File: b\.ts\n/)

  const freeform = reconstructApplyPatchInput(
    "batch",
    JSON.stringify({
      patchText: "*** Begin Patch ***\n*** Add File: c.txt\n+c\n*** End Patch ***",
    }),
  )
  assert.equal(freeform.includes("*** Begin Patch ***"), false)
  assert.match(freeform, /\*\*\* Add File: c\.txt\n/)
})

test("buildApplyPatchText keeps markers correct", () => {
  const text = buildApplyPatchText([
    {
      type: "update_file",
      path: "f.ts",
      hunks: [
        {
          lines: [
            { op: "remove", text: "a" },
            { op: "add", text: "b" },
          ],
        },
      ],
    },
  ])
  assert.equal(text, "*** Begin Patch\n*** Update File: f.ts\n@@\n-a\n+b\n*** End Patch\n")
})
