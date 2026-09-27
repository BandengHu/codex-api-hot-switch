import assert from "node:assert/strict"
import test from "node:test"

import { buildAnthropicRequest } from "./anthropic"
import { encodeAnthropicThinkingBlocks } from "./anthropic-thinking"
import { buildGeminiRequest } from "./gemini"
import { TOOL_RESULT_MEDIA_ATTACHED_MARKER } from "./chat-tool-media"

function target(protocol: "anthropic" | "gemini", modelId: string) {
  return {
    provider: {
      id: `provider-${protocol}`,
      name: `${protocol} provider`,
      protocol,
      baseUrl:
        protocol === "anthropic"
          ? "https://api.anthropic.com/v1"
          : "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "test-key",
      headers: [],
      endpoints: [],
      timeoutMs: 60_000,
      enabled: true,
    },
    model: {
      id: `model-${protocol}`,
      name: modelId,
      providerId: `provider-${protocol}`,
      modelId,
      enabled: true,
      supportsReasoning: false,
      reasoningDialect: "none",
    },
    modelId,
    requestedModel: `switchgate__model_${protocol}`,
    reasoning: "off",
    paused: false,
  } as any
}

function responsesToolRound(output: unknown) {
  return {
    model: "client-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the image." }],
      },
      {
        type: "function_call",
        call_id: "call_image",
        name: "view_image",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_image",
        output,
      },
    ],
  }
}

function mcpImageOutput(data = "IMAGE_SENTINEL") {
  return JSON.stringify({
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data,
      },
    ],
  })
}

test("Responses 工具图片作为 Anthropic 原生 tool_result 图片发送", () => {
  const built = buildAnthropicRequest(
    target("anthropic", "claude-sonnet-5"),
    "v1/responses",
    responsesToolRound(mcpImageOutput()),
  )
  const body = built.rewrittenBody as any
  const toolResult = body.messages[2].content[0]

  assert.equal(toolResult.type, "tool_result")
  assert.equal(toolResult.content[0].type, "text")
  assert.match(toolResult.content[0].text, new RegExp(TOOL_RESULT_MEDIA_ATTACHED_MARKER))
  assert.equal(toolResult.content[1].type, "image")
  assert.equal(toolResult.content[1].source.media_type, "image/png")
  assert.equal(toolResult.content[1].source.data, "IMAGE_SENTINEL")
})

test("媒体工具输出中的残余大段 base64 会被夹断", () => {
  const residual = "A".repeat(20_000)
  const output = JSON.stringify({
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: "IMAGE_SENTINEL",
      },
      {
        type: "video",
        data: residual,
      },
    ],
  })
  const built = buildAnthropicRequest(
    target("anthropic", "claude-sonnet-5"),
    "v1/responses",
    responsesToolRound(output),
  )
  const serialized = JSON.stringify(built.rewrittenBody)

  assert.match(serialized, /\[cc-switch: omitted 20000 bytes\]/)
  assert.equal(serialized.includes("A".repeat(64)), false)
})

test("Gemini 3 把工具图片放进 functionResponse.parts", () => {
  const built = buildGeminiRequest(
    target("gemini", "gemini-3-pro"),
    "v1/responses",
    responsesToolRound(mcpImageOutput()),
  )
  const body = built.rewrittenBody as any
  const parts = body.contents[2].parts
  const functionPart = parts.find((part: any) => part.functionResponse)

  assert.equal(functionPart.functionResponse.name, "view_image")
  assert.equal(functionPart.functionResponse.parts[0].inlineData.mimeType, "image/png")
  assert.equal(functionPart.functionResponse.parts[0].inlineData.data, "IMAGE_SENTINEL")
  assert.equal(parts.some((part: any) => part.inlineData), false)
})

test("旧 Gemini 把工具图片放进同一 user turn 的后续媒体 part", () => {
  const built = buildGeminiRequest(
    target("gemini", "gemini-2.5-pro"),
    "v1/responses",
    responsesToolRound(mcpImageOutput()),
  )
  const body = built.rewrittenBody as any
  const parts = body.contents[2].parts

  assert.equal(parts[0].functionResponse.name, "view_image")
  assert.equal("parts" in parts[0].functionResponse, false)
  assert.match(parts[1].text, /media output of tool call call_image/)
  assert.equal(parts[2].inlineData.mimeType, "image/png")
  assert.equal(parts[2].inlineData.data, "IMAGE_SENTINEL")
})

test("Anthropic 原生桥保留有后续工具调用的加密 reasoning", () => {
  const encryptedContent = encodeAnthropicThinkingBlocks([
    {
      type: "thinking",
      thinking: "Need a tool.",
      signature: "signed-thinking",
    },
  ])
  assert.ok(encryptedContent)

  const built = buildAnthropicRequest(
    target("anthropic", "claude-sonnet-5"),
    "v1/responses",
    {
      model: "client-model",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect it." }],
        },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Need a tool." }],
          encrypted_content: encryptedContent,
        },
        {
          type: "function_call",
          status: "completed",
          call_id: "call_1",
          name: "inspect",
          arguments: "{}",
        },
      ],
    },
  )
  const body = built.rewrittenBody as any
  const assistant = body.messages.find((message: any) => message.role === "assistant")

  assert.equal(assistant.content[0].type, "thinking")
  assert.equal(assistant.content[0].signature, "signed-thinking")
  assert.equal(assistant.content[1].type, "tool_use")
})

test("Anthropic 原生桥删除没有后续 assistant 输出的孤儿 reasoning", () => {
  const encryptedContent = encodeAnthropicThinkingBlocks([
    {
      type: "thinking",
      thinking: "Interrupted.",
      signature: "orphan-signature",
    },
  ])
  const built = buildAnthropicRequest(
    target("anthropic", "claude-sonnet-5"),
    "v1/responses",
    {
      model: "client-model",
      input: [
        {
          type: "reasoning",
          id: "rs_orphan",
          summary: [{ type: "summary_text", text: "Interrupted." }],
          encrypted_content: encryptedContent,
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue." }],
        },
      ],
    },
  )
  const body = built.rewrittenBody as any

  assert.equal(
    body.messages.some((message: any) =>
      message.content.some((block: any) =>
        block.type === "thinking" || block.type === "redacted_thinking")),
    false,
  )
})

test("原生桥 completed 工具调用拒绝畸形参数，incomplete 调用归一为空对象", () => {
  const request = (status: "completed" | "incomplete") => ({
    model: "client-model",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run it." }],
      },
      {
        type: "function_call",
        status,
        call_id: `call_${status}`,
        name: "exec_command",
        arguments: '{"cmd":',
      },
    ],
  })

  assert.throws(
    () =>
      buildAnthropicRequest(
        target("anthropic", "claude-sonnet-5"),
        "v1/responses",
        request("completed"),
      ),
    /arguments 不是合法 JSON/,
  )

  const built = buildAnthropicRequest(
    target("anthropic", "claude-sonnet-5"),
    "v1/responses",
    request("incomplete"),
  )
  const body = built.rewrittenBody as any
  const toolUse = body.messages
    .flatMap((message: any) => message.content)
    .find((block: any) => block.type === "tool_use")
  assert.deepEqual(toolUse.input, {})
})
