import assert from "node:assert/strict"
import test from "node:test"
import {
  filterLowConfidenceResults,
  normalizeScore,
} from "./normalize"
import type { WebSearchResult } from "./types"

function result(title: string, summary: string, score = 0.8): WebSearchResult {
  return {
    query: "",
    title,
    url: `https://example.com/${encodeURIComponent(title)}`,
    domain: "example.com",
    summary,
    score,
    publishedAt: null,
    provider: "exa",
  }
}

test("filters obvious synthetic queries instead of returning ranked noise", () => {
  const filtered = filterLowConfidenceResults(
    [result("Unrelated page", "A page with no useful relationship.")],
    "asdfqwzzx nonexistentterm12345",
  )
  assert.deepEqual(filtered, [])
})

test("keeps ordinary Chinese queries with matching evidence", () => {
  const candidate = result("桂林天气预报", "桂林今天有小雨，气温 28℃。")
  assert.deepEqual(
    filterLowConfidenceResults([candidate], "桂林天气"),
    [candidate],
  )
})

test("rank alone cannot make an unrelated result look highly confident", () => {
  assert.ok(
    normalizeScore(undefined, 0, 20, "asdfqwzzx nonexistentterm12345", "unrelated page") < 0.4,
  )
})
