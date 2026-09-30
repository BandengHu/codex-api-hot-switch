import assert from "node:assert/strict"
import test from "node:test"

import { chatUsageToResponsesUsage } from "./chat-usage"

test("Chat usage maps DeepSeek documented cache-hit tokens", () => {
  const usage = chatUsageToResponsesUsage({
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    prompt_cache_hit_tokens: 600,
    prompt_cache_miss_tokens: 400,
  })

  assert.equal(usage.input_tokens, 1000)
  assert.equal(usage.output_tokens, 100)
  assert.equal(usage.input_tokens_details.cached_tokens, 600)
})

test("standard Chat cache fields take precedence over DeepSeek fallback", () => {
  const usage = chatUsageToResponsesUsage({
    prompt_tokens: 1000,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: 0 },
    prompt_cache_hit_tokens: 600,
  })

  assert.equal(usage.input_tokens_details.cached_tokens, 0)
})
