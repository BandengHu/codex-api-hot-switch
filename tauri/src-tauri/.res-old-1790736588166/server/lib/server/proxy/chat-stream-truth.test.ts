import assert from "node:assert/strict"
import test from "node:test"

import {
  chatStreamTruthFromSource,
  lastInputItemTypeFromResponsesInput,
} from "./chat-stream-truth"

test("lastInputItemTypeFromResponsesInput returns the type of the last input item", () => {
  assert.equal(
    lastInputItemTypeFromResponsesInput([
      { type: "message", role: "user" },
      { type: "function_call_output", call_id: "call_1" },
    ]),
    "function_call_output",
  )
  assert.equal(lastInputItemTypeFromResponsesInput("plain string"), "text")
  assert.equal(lastInputItemTypeFromResponsesInput([]), "")
  assert.equal(lastInputItemTypeFromResponsesInput(undefined), "")
})

test("chatStreamTruthFromSource records upstream truth for a normal completed stream", () => {
  const truth = chatStreamTruthFromSource(
    {
      finishReason: "stop",
      sawChoice: true,
      sawDone: true,
      completed: true,
      toolCallCount: 2,
      content: "hello",
      reasoning: "thinking",
      inlineThinkBuffer: "",
      inlineThinkMode: "text",
    },
    { input: [{ type: "function_call_output" }] },
  )
  assert.equal(truth.upstreamFinishReason, "stop")
  assert.equal(truth.finalFinishReason, "stop")
  assert.equal(truth.finishReasonSource, "upstream")
  assert.equal(truth.sawChoice, true)
  assert.equal(truth.sawDoneFrame, true)
  assert.equal(truth.toolCallCount, 2)
  assert.equal(truth.lastInputItemType, "function_call_output")
  assert.equal(truth.visibleChars, 5)
  assert.equal(truth.reasoningChars, 8)
  assert.equal(truth.settledAs, "completed")
})

test("chatStreamTruthFromSource records synthesized length when upstream ends silently with output", () => {
  const truth = chatStreamTruthFromSource(
    {
      finishReason: "",
      sawChoice: true,
      sawDone: false,
      completed: false,
      toolCallCount: 0,
      content: "",
      reasoning: "only reasoning",
      inlineThinkBuffer: "",
      inlineThinkMode: "text",
    },
    { input: [{ type: "message" }] },
  )
  assert.equal(truth.upstreamFinishReason, "")
  assert.equal(truth.finalFinishReason, "length")
  assert.equal(truth.finishReasonSource, "synthesized")
  assert.equal(truth.sawDoneFrame, false)
  assert.equal(truth.settledAs, "failed")
  assert.equal(truth.reasoningChars, 14)
})

test("chatStreamTruthFromSource reports aborted status without changing finish truth", () => {
  const truth = chatStreamTruthFromSource(
    {
      finishReason: "",
      sawChoice: true,
      sawDone: false,
      completed: false,
      toolCallCount: 1,
      content: "partial",
      reasoning: "",
      inlineThinkBuffer: "",
      inlineThinkMode: "text",
    },
    {},
    { aborted: true },
  )
  assert.equal(truth.settledAs, "aborted")
  assert.equal(truth.finalFinishReason, "length")
  assert.equal(truth.finishReasonSource, "synthesized")
})

test("chatStreamTruthFromSource defaults final finish reason to stop for completed streams", () => {
  const truth = chatStreamTruthFromSource(
    {
      finishReason: "",
      sawChoice: true,
      sawDone: true,
      completed: true,
      content: "ok",
      reasoning: "",
      inlineThinkBuffer: "",
      inlineThinkMode: "text",
    },
    {},
  )
  assert.equal(truth.upstreamFinishReason, "")
  assert.equal(truth.finalFinishReason, "stop")
  assert.equal(truth.finishReasonSource, "synthesized")
  assert.equal(truth.settledAs, "completed")
})
