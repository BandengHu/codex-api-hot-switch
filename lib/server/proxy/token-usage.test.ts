import assert from "node:assert/strict"
import test from "node:test"
import {
  extractTokenUsage,
  normalizeTokenUsage,
  TokenUsageSseCollector,
} from "@/lib/server/proxy/token-usage-core"

const encoder = new TextEncoder()

test("normalizes cache fields and explicit upstream cost", () => {
  const usage = normalizeTokenUsage({
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: { cached_tokens: 80 },
    cost: { amount: 0.003252, currency: "CNY" },
  })

  assert.equal(usage?.cachedInputTokens, 80)
  assert.equal(usage?.upstreamCost?.amount, 0.003252)
  assert.equal(usage?.upstreamCost?.currency, "CNY")
  assert.equal(
    extractTokenUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cost: { amount: 0.003252, currency: "CNY" },
      },
    })?.upstreamCost?.source,
    "upstream",
  )
})

test("records first meaningful Responses output time", () => {
  const collector = new TokenUsageSseCollector()
  collector.push(
    encoder.encode(
      'event: response.created\ndata: {"type":"response.created"}\n\n',
    ),
    1_000,
  )
  collector.push(
    encoder.encode(
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"首"}\n\n',
    ),
    2_800,
  )
  collector.push(
    encoder.encode(
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}\n\n',
    ),
    3_000,
  )
  collector.finish(3_100)

  assert.equal(collector.firstOutputMs(1_000), 1_800)
  assert.equal(collector.current()?.totalTokens, 12)
  assert.equal(collector.terminal(), "completed")
})

test("ignores Chat role-only chunks before visible output", () => {
  const collector = new TokenUsageSseCollector()
  collector.push(
    encoder.encode(
      'data: {"type":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
    ),
    1_000,
  )
  collector.push(
    encoder.encode(
      'data: {"type":"chat.completion.chunk","choices":[{"delta":{"content":"好"}}]}\n\n',
    ),
    1_500,
  )

  assert.equal(collector.firstOutputMs(1_000), 500)
})
