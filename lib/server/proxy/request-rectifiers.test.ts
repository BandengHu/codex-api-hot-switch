import assert from "node:assert/strict"
import test from "node:test"

import { maybeRectifyUpstreamError } from "./request-rectifiers"

function target() {
  return {
    provider: {
      protocol: "openai-responses",
    },
  } as any
}

test("火山纯文本错误无需出现 image 字样也会触发图片降级", () => {
  const result = maybeRectifyUpstreamError({
    target: target(),
    status: 400,
    payload: {
      error: {
        message: "Model only support text input Request id: 021783",
      },
    },
    rewrittenBody: {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "inspect" },
            { type: "input_image", image_url: "data:image/png;base64,abc" },
          ],
        },
      ],
    },
    attempted: new Set(),
  })

  assert.equal(result?.kind, "unsupported-image")
  assert.equal((result?.body as any).input[0].content[1].type, "input_text")
  assert.match((result?.body as any).input[0].content[1].text, /Unsupported Image/)
})

test("不支持图片的重试只执行一次", () => {
  const result = maybeRectifyUpstreamError({
    target: target(),
    status: 400,
    payload: { error: { message: "Model only supports text input" } },
    rewrittenBody: {
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,abc" }],
        },
      ],
    },
    attempted: new Set(["unsupported-image"]),
  })

  assert.equal(result, null)
})
