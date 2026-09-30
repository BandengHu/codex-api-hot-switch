import assert from "node:assert/strict"
import test from "node:test"

import { CodexChatHistoryStore } from "./codex-chat-history"

function message(role: "user" | "assistant", text: string) {
  return {
    type: "message",
    role,
    content: [
      {
        type: role === "assistant" ? "output_text" : "input_text",
        text,
      },
    ],
  }
}

test("expands a previous_response_id chain without storing full snapshots", () => {
  const store = new CodexChatHistoryStore()
  const user1 = message("user", "one")
  const assistant1 = message("assistant", "first")
  const user2 = message("user", "two")
  const assistant2 = message("assistant", "second")

  store.recordResponse(
    { id: "resp_1", output: [assistant1] },
    { input: [user1] },
  )
  store.recordResponse(
    { id: "resp_2", output: [assistant2] },
    { previous_response_id: "resp_1", input: [user2] },
  )

  const next = {
    previous_response_id: "resp_2",
    input: [message("user", "three")],
  }
  assert.equal(store.expandRequestHistory(next), 4)
  assert.equal("previous_response_id" in next, false)
  assert.deepEqual(next.input.slice(0, 4), [
    user1,
    assistant1,
    user2,
    assistant2,
  ])
  assert.deepEqual(store.stats(), {
    responseCount: 2,
    completeResponseCount: 2,
    transcriptNodeCount: 2,
    transcriptItemCount: 4,
    transcriptBytes: store.stats().transcriptBytes,
  })
})

test("deduplicates a repeated full transcript by its longest cached prefix", () => {
  const store = new CodexChatHistoryStore()
  const user1 = message("user", "one")
  const assistant1 = message("assistant", "first")
  const user2 = message("user", "two")
  const assistant2 = message("assistant", "second")

  store.recordResponse(
    { id: "resp_1", output: [assistant1] },
    { input: [user1] },
  )
  store.recordResponse(
    { id: "resp_2", output: [assistant2] },
    { input: [user1, assistant1, user2] },
  )

  const stats = store.stats()
  assert.equal(stats.transcriptNodeCount, 2)
  assert.equal(stats.transcriptItemCount, 4)

  const next = {
    previous_response_id: "resp_2",
    input: [message("user", "three")],
  }
  assert.equal(store.expandRequestHistory(next), 4)
})

test("keeps long chains linear in stored transcript items", () => {
  const store = new CodexChatHistoryStore()
  const payload = "x".repeat(20_000)
  let previousResponseId = ""

  for (let turn = 0; turn < 100; turn += 1) {
    const responseId = `resp_${turn}`
    store.recordResponse(
      {
        id: responseId,
        output: [message("assistant", `answer-${turn}`)],
      },
      {
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        input: [message("user", `${turn}-${payload}`)],
      },
    )
    previousResponseId = responseId
  }

  const stats = store.stats()
  assert.equal(stats.responseCount, 100)
  assert.equal(stats.transcriptNodeCount, 100)
  assert.equal(stats.transcriptItemCount, 200)
  assert.ok(stats.transcriptBytes < 3 * 1024 * 1024)

  const next = {
    previous_response_id: previousResponseId,
    input: [message("user", "continue")],
  }
  assert.equal(store.expandRequestHistory(next), 200)
  assert.equal(next.input.length, 201)
})

test("does not expand an incomplete chain when its previous response is missing", () => {
  const store = new CodexChatHistoryStore()
  store.recordResponse(
    {
      id: "resp_orphan",
      output: [message("assistant", "partial context")],
    },
    {
      previous_response_id: "resp_missing",
      input: [message("user", "continue")],
    },
  )

  const next = {
    previous_response_id: "resp_orphan",
    input: [message("user", "again")],
  }
  assert.equal(store.expandRequestHistory(next), 0)
  assert.equal(next.previous_response_id, "resp_orphan")
  assert.equal(store.stats().completeResponseCount, 0)
})

test("restores tool calls after transcript storage was changed", () => {
  const store = new CodexChatHistoryStore()
  store.recordResponse(
    {
      id: "resp_tool",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "apply_patch",
          arguments: "{\"patch\":\"test\"}",
        },
      ],
    },
    { input: [message("user", "edit")] },
  )

  const next: Record<string, any> = {
    previous_response_id: "resp_tool",
    input: [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "done",
      },
    ],
  }
  assert.equal(store.enrichRequest(next), 1)
  assert.equal(next.input[0].type, "function_call")
  assert.equal(next.input[0].name, "apply_patch")
  assert.equal(next.input[1].type, "function_call_output")
})

test("evicts old responses when the transcript byte budget is exceeded", () => {
  const store = new CodexChatHistoryStore({
    maxResponses: 10,
    maxTranscriptBytes: 600,
  })

  for (let index = 0; index < 4; index += 1) {
    store.recordResponse(
      {
        id: `resp_${index}`,
        output: [message("assistant", "a".repeat(120))],
      },
      { input: [message("user", "u".repeat(120))] },
    )
  }

  const stats = store.stats()
  assert.ok(stats.responseCount < 4)
  assert.ok(stats.transcriptBytes <= 600 || stats.responseCount === 1)
})
