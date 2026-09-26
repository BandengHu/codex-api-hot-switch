import assert from "node:assert/strict"
import test from "node:test"

import { responsesToChatCompletions } from "./chat-compatible"
import {
  applyChatReasoningOptions,
  resolveReasoningDialect,
} from "./reasoning-dialects"

function chatTarget(modelId: string) {
  return {
    provider: {
      id: "provider-chat",
      name: "Chat Provider",
      protocol: "openai-chat",
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      headers: [],
      endpoints: [],
      timeoutMs: 60_000,
      reasoningDialect: "auto",
      enabled: true,
    },
    model: {
      id: `model-${modelId}`,
      name: modelId,
      providerId: "provider-chat",
      modelId,
      enabled: true,
      supportsReasoning: true,
      reasoningDialect: "inherit",
    },
    modelId,
    requestedModel: `switchgate__${modelId}`,
    reasoning: "auto",
    paused: false,
  } as any
}

test("OpenAI reasoning effort preserves Codex xhigh, max and ultra verbatim", () => {
  for (const effort of ["xhigh", "max", "ultra"]) {
    const result: Record<string, unknown> = {}
    applyChatReasoningOptions(
      result,
      { reasoning: { effort } },
      "openai-reasoning-effort",
      "gpt-5.6-sol",
    )
    assert.equal(result.reasoning_effort, effort)
  }
})

test("Grok 4.5+ and saved grok-build models infer reasoning effort support", () => {
  for (const model of [
    "grok-4.5",
    "grok-4.7-build",
    "grok-4.10",
    "grok-build-0.1",
  ]) {
    assert.equal(resolveReasoningDialect(chatTarget(model)), "openai-reasoning-effort")
  }
  for (const model of ["grok-4", "grok-4.4", "grok-4.build"]) {
    assert.equal(resolveReasoningDialect(chatTarget(model)), "none")
  }
})

test("Grok Responses to Chat conversion keeps xhigh instead of dropping it", () => {
  const converted = responsesToChatCompletions(
    {
      model: "grok-4.7",
      reasoning: { effort: "xhigh" },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      ],
    },
    chatTarget("grok-4.7"),
    { applyLanguagePolicy: false },
  )

  assert.equal(converted.body.reasoning_effort, "xhigh")
})
