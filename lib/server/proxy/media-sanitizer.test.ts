import assert from "node:assert/strict"
import test from "node:test"

import { sanitizeImagesForTargetModel } from "./media-sanitizer"

function responsesImageBody() {
  return {
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "inspect" },
          { type: "input_image", image_url: "data:image/png;base64,abc" },
        ],
      },
    ],
  } as any
}

test("GLM-5.2 及 1M 映射模型在发送前剥离图片", () => {
  for (const modelId of ["glm-5.2", "GLM-5.2[1M]", "zai-org/GLM-5.2"]) {
    const body = responsesImageBody()
    const result = sanitizeImagesForTargetModel(body, undefined, modelId)

    assert.equal(result.replacedImages, 1, modelId)
    assert.equal(body.input[0].content[1].type, "input_text", modelId)
  }
})

test("GLM-5.2v 不被误判为纯文本模型", () => {
  const body = responsesImageBody()
  const result = sanitizeImagesForTargetModel(body, undefined, "glm-5.2v")

  assert.equal(result.replacedImages, 0)
  assert.equal(body.input[0].content[1].type, "input_image")
})
