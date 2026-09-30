import assert from "node:assert/strict"
import test from "node:test"

import { findProviderPreset } from "./provider-presets"

test("智谱预设包含支持视觉的 GLM-5.3-Flash", () => {
  const preset = findProviderPreset("zhipu-glm")
  const flash = preset?.models.find((model) => model.modelId === "glm-5.3-flash")
  const base = preset?.models.find((model) => model.modelId === "glm-5.3")

  assert.ok(flash)
  assert.equal(flash.contextLength, 1048576)
  assert.equal(flash.supportsReasoning, true)
  assert.equal(flash.supportsVision, true)
  assert.deepEqual(flash.capabilities, ["chat", "reasoning", "vision", "tools"])
  assert.equal(base?.supportsVision, false)
})
