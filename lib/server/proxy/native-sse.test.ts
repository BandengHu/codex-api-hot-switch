import assert from "node:assert/strict"
import test from "node:test"

import { createNativeSseStreamToClient } from "./native-sse"

const encoder = new TextEncoder()

function anthropicAdapter() {
  return {
    type: "native",
    protocol: "anthropic",
    source: "responses",
    requestIsStream: true,
    requestedModel: "claude-fable-5",
    reasoningEnabled: true,
    reverseToolNameMap: {},
    toolContext: undefined,
  } as any
}

async function transformAnthropicSse(frames: string[]) {
  const stream = createNativeSseStreamToClient({
    adapter: anthropicAdapter(),
    model: "claude-fable-5",
  } as any)
  const readPromise = new Response(stream.readable).text()
  const writer = stream.writable.getWriter()
  await writer.write(encoder.encode(frames.join("\n\n") + "\n\n"))
  await writer.close()
  return await readPromise
}

function frame(event: string, payload: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}`
}

test("fails an Anthropic stream that stops without any output", async () => {
  const output = await transformAnthropicSse([
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_empty",
        usage: { input_tokens: 10 },
      },
    }),
    frame("message_stop", { type: "message_stop" }),
  ])

  assert.match(output, /"type":"response\.failed"/)
  assert.match(output, /"type":"empty_upstream_output"/)
  assert.doesNotMatch(output, /"type":"response\.completed"/)
  assert.match(output, /data: \[DONE\]/)
})

test("completes an Anthropic stream that contains visible text", async () => {
  const output = await transformAnthropicSse([
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_text",
        usage: { input_tokens: 10 },
      },
    }),
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "hello" },
    }),
    frame("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }),
    frame("message_stop", { type: "message_stop" }),
  ])

  assert.match(output, /"type":"response\.output_text\.delta"/)
  assert.match(output, /"type":"response\.completed"/)
  assert.doesNotMatch(output, /"type":"empty_upstream_output"/)
  assert.match(output, /data: \[DONE\]/)
})
