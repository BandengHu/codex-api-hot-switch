import { test } from "node:test"
import assert from "node:assert/strict"
import {
  fetchWithModelCapacityRetry,
  isModelCapacityMessage,
} from "./model-capacity-retry"

test("recognizes account-pool capacity errors", () => {
  assert.equal(isModelCapacityMessage("Too many pending requests, please retry later"), true)
  assert.equal(isModelCapacityMessage("No available accounts"), true)
  assert.equal(isModelCapacityMessage("Concurrency limit exceeded for account"), true)
  assert.equal(isModelCapacityMessage("daily usage limit exceeded"), false)
  assert.equal(isModelCapacityMessage("你没有余额拉"), false)
})

test("retries a capacity HTTP error without changing the request", async () => {
  let attempts = 0
  const result = await fetchWithModelCapacityRetry({
    enabled: true,
    requestIsStream: false,
    fetchResponse: async () => {
      attempts += 1
      if (attempts < 3) {
        return Response.json(
          { error: { message: "Too many pending requests, please retry later" } },
          { status: 429 },
        )
      }
      return Response.json({ model: "claude-fable-5", content: "FABLE_OK" })
    },
  })

  assert.equal(result.retryCount, 2)
  assert.equal(attempts, 3)
  assert.equal(result.response.status, 200)
  assert.deepEqual(await result.response.json(), {
    model: "claude-fable-5",
    content: "FABLE_OK",
  })
})
