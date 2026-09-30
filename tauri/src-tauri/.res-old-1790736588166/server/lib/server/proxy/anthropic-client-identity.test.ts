import { test } from "node:test"
import assert from "node:assert/strict"
import { applyAnthropicClientIdentity } from "./anthropic-client-identity"

test("adds Claude Code identity only for claude-fable-5", () => {
  const fableHeaders = new Headers()
  applyAnthropicClientIdentity(fableHeaders, "claude-fable-5")

  assert.equal(fableHeaders.get("user-agent"), "claude-cli/2.1.161 (external, cli)")
  assert.equal(fableHeaders.get("anthropic-beta"), "claude-code-20250219")
  assert.equal(fableHeaders.get("x-app"), "cli")

  const opusHeaders = new Headers()
  applyAnthropicClientIdentity(opusHeaders, "claude-opus-4-8")
  assert.equal(opusHeaders.has("user-agent"), false)
  assert.equal(opusHeaders.has("anthropic-beta"), false)
  assert.equal(opusHeaders.has("x-app"), false)
})

test("preserves custom identity and appends the required beta", () => {
  const headers = new Headers({
    "user-agent": "custom-client",
    "anthropic-beta": "interleaved-thinking-2025-05-14",
    "x-app": "custom-app",
  })

  applyAnthropicClientIdentity(headers, "claude-fable-5")

  assert.equal(headers.get("user-agent"), "custom-client")
  assert.equal(
    headers.get("anthropic-beta"),
    "claude-code-20250219,interleaved-thinking-2025-05-14",
  )
  assert.equal(headers.get("x-app"), "custom-app")
})
