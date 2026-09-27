import assert from "node:assert/strict"
import test from "node:test"

import {
  ProxyBodyTooLargeError,
  readBodyBytesWithLimit,
  readResponseBytesWithLimit,
} from "./body-size-limit"

function streamOf(...chunks: number[][]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk))
      controller.close()
    },
  })
}

test("流式读取在累计超过上限时立即拒绝", async () => {
  await assert.rejects(
    readBodyBytesWithLimit(streamOf([1, 2, 3], [4, 5, 6]), {
      label: "测试体",
      maxBytes: 5,
    }),
    (error) =>
      error instanceof ProxyBodyTooLargeError &&
      error.limit === 5 &&
      error.observedBytes === 6,
  )
})

test("声明的 Content-Length 超限时不读取响应体", async () => {
  const response = new Response("ok", {
    headers: { "content-length": "6" },
  })

  await assert.rejects(
    readResponseBytesWithLimit(response, 5),
    ProxyBodyTooLargeError,
  )
  assert.equal(response.bodyUsed, false)
})

test("恰好等于上限的响应体允许读取", async () => {
  const response = new Response(Uint8Array.from([1, 2, 3, 4, 5]))
  const bytes = await readResponseBytesWithLimit(response, 5)

  assert.deepEqual([...bytes], [1, 2, 3, 4, 5])
})
