import assert from "node:assert/strict"
import test from "node:test"
import {
  cacheHitRate,
  sumTokenStats,
  tokenStatFromLog,
} from "@/lib/token-stats"
import type { RequestLog, TokenUsage } from "@/lib/types"

function requestLog(id: string, tokenUsage: TokenUsage): RequestLog {
  return {
    id,
    timestamp: "2026-08-13T00:00:00.000Z",
    codexModel: "switchgate__auto",
    finalProviderId: "provider",
    finalModelId: "model",
    reasoning: "high",
    statusCode: 200,
    durationMs: 1000,
    tokenUsage,
    rawRequest: "",
    rewrittenRequest: "",
    responseSummary: "",
  }
}

test("calculates a weighted cache hit rate from reported requests", () => {
  const entries = [
    tokenStatFromLog(
      requestLog("hit", {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 80,
        cacheUsageReported: true,
      }),
    ),
    tokenStatFromLog(
      requestLog("zero", {
        inputTokens: 300,
        outputTokens: 20,
        cachedInputTokens: 0,
        cacheUsageReported: true,
      }),
    ),
    tokenStatFromLog(
      requestLog("missing", {
        inputTokens: 10_000,
        outputTokens: 30,
      }),
    ),
  ].filter((entry) => entry != null)

  const totals = sumTokenStats(entries)
  const rate = cacheHitRate({
    cachedInputTokens: totals.cacheMeasuredCachedInputTokens,
    cacheMeasuredInputTokens: totals.cacheMeasuredInputTokens,
  })

  assert.equal(totals.cacheMeasuredCachedInputTokens, 80)
  assert.equal(totals.cacheMeasuredInputTokens, 400)
  assert.equal(totals.cacheMeasuredRequests, 2)
  assert.equal(rate, 0.2)
})

test("returns no cache hit rate when every request omits cache usage", () => {
  const entry = tokenStatFromLog(
    requestLog("missing", {
      inputTokens: 100,
      outputTokens: 10,
    }),
  )

  assert.ok(entry)
  assert.equal(entry.cacheMeasuredInputTokens, 0)
  assert.equal(entry.cacheMeasuredRequests, 0)
  assert.equal(
    cacheHitRate({
      cachedInputTokens: entry.cacheMeasuredCachedInputTokens,
      cacheMeasuredInputTokens: entry.cacheMeasuredInputTokens,
    }),
    undefined,
  )
})

test("keeps an explicit zero-input cache report measurable", () => {
  const entry = tokenStatFromLog(
    requestLog("zero-input", {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheUsageReported: true,
    }),
  )

  assert.ok(entry)
  assert.equal(entry.cacheMeasuredInputTokens, 0)
  assert.equal(entry.cacheMeasuredCachedInputTokens, 0)
  assert.equal(entry.cacheMeasuredRequests, 1)
})
