import assert from "node:assert/strict"
import test from "node:test"
import { compactTokenStats } from "@/lib/server/token-stat-retention"
import { sumTokenStats, tokenStatsSince } from "@/lib/token-stats"
import type { TokenStatEntry } from "@/lib/types"

const ORIGINAL_RESET = "1970-01-01T00:00:00.000Z"

function entry(
  index: number,
  totalTokens: number,
  timestamp = "2026-07-26T00:00:00.000Z",
): TokenStatEntry {
  return {
    id: `token-${index}`,
    timestamp,
    providerId: "provider",
    modelId: "model",
    codexModel: "codex",
    statusCode: 200,
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    requestCount: 1,
    aggregation: "request",
    resetAt: ORIGINAL_RESET,
  }
}

test("token compaction preserves totals beyond the recent request limit", () => {
  const entries = Array.from({ length: 2005 }, (_, index) =>
    entry(
      index,
      index + 1,
      `2026-07-26T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
    ),
  )
  const compacted = compactTokenStats(
    entries,
    Date.parse("2026-07-26T12:00:00.000Z"),
  )

  assert.equal(
    compacted.filter((item) => item.aggregation === "request").length,
    2000,
  )
  assert.ok(compacted.some((item) => item.aggregation === "day"))
  assert.deepEqual(sumTokenStats(compacted), sumTokenStats(entries))
})

test("history rollups stay separate across reset eras", () => {
  const currentEntries = Array.from({ length: 2000 }, (_, index) =>
    entry(index + 10, 1),
  )
  const beforeReset = entry(1, 10, "2026-01-01T00:00:00.000Z")
  const afterReset = {
    ...entry(2, 20, "2026-01-02T00:00:00.000Z"),
    resetAt: "2026-01-01T12:00:00.000Z",
  }
  const entries = [...currentEntries, beforeReset, afterReset]
  const compacted = compactTokenStats(
    entries,
    Date.parse("2026-07-26T12:00:00.000Z"),
  )

  const resetEras = new Set(
    compacted
      .filter((item) => item.aggregation === "history")
      .map((item) => item.resetAt),
  )
  assert.deepEqual([...resetEras].sort(), [
    ORIGINAL_RESET,
    "2026-01-01T12:00:00.000Z",
  ])
  assert.deepEqual(sumTokenStats(compacted), sumTokenStats(entries))
})

test("reset filtering excludes previous rollup eras", () => {
  const currentReset = "2026-07-26T08:00:00.000Z"
  const compacted = compactTokenStats(
    [
      {
        ...entry(1, 100, "2026-01-01T00:00:00.000Z"),
        aggregation: "history",
      },
      {
        ...entry(2, 20, "2026-07-26T09:00:00.000Z"),
        resetAt: currentReset,
      },
    ],
    Date.parse("2026-07-26T12:00:00.000Z"),
  )

  assert.equal(sumTokenStats(tokenStatsSince(compacted, currentReset)).totalTokens, 20)
})
