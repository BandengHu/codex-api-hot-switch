import "server-only"

const FABLE_MODEL = "claude-fable-5"
const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.161 (external, cli)"
const CLAUDE_CODE_BETA = "claude-code-20250219"

function hasToken(value: string | null, token: string) {
  return value
    ?.split(",")
    .some((item) => item.trim().toLowerCase() === token.toLowerCase())
}

export function applyAnthropicClientIdentity(headers: Headers, modelId: string) {
  if (modelId.trim().toLowerCase() !== FABLE_MODEL) return

  if (!headers.has("user-agent")) {
    headers.set("user-agent", CLAUDE_CODE_USER_AGENT)
  }

  if (!hasToken(headers.get("anthropic-beta"), CLAUDE_CODE_BETA)) {
    const existing = headers.get("anthropic-beta")?.trim()
    headers.set(
      "anthropic-beta",
      existing ? `${CLAUDE_CODE_BETA},${existing}` : CLAUDE_CODE_BETA,
    )
  }

  if (!headers.has("x-app")) {
    headers.set("x-app", "cli")
  }
}
