import "server-only"

const GEMINI_SYNTHETIC_ID_PREFIX = "gemini_synth_"

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

export function synthesizeGeminiToolCallId() {
  return `${GEMINI_SYNTHETIC_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`
}

export function isSynthesizedGeminiToolCallId(value: unknown) {
  return safeTrim(value).startsWith(GEMINI_SYNTHETIC_ID_PREFIX)
}

export function geminiClientToolCallId(upstreamId: unknown) {
  const id = safeTrim(upstreamId)
  return id || synthesizeGeminiToolCallId()
}

export function geminiUpstreamToolCallId(clientId: unknown) {
  const id = safeTrim(clientId)
  if (!id || isSynthesizedGeminiToolCallId(id)) return undefined
  return id
}
