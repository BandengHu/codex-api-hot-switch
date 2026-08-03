type AnyRecord = Record<string, unknown>

const MAX_SCAN_NODES = 800
const MAX_SCAN_TEXT = 24000

function collectText(value: unknown, state = { nodes: 0, text: "" }): string {
  if (state.nodes > MAX_SCAN_NODES || state.text.length > MAX_SCAN_TEXT) {
    return state.text
  }
  state.nodes += 1
  if (typeof value === "string") {
    state.text += `\n${value}`
    return state.text
  }
  if (!value || typeof value !== "object") return state.text
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, state)
    return state.text
  }
  for (const child of Object.values(value as AnyRecord)) collectText(child, state)
  return state.text
}

export function isMemoryMaintenanceRequest(body: unknown) {
  const text = collectText(body)
  return (
    /\bMemory Writing Agent\b/i.test(text) ||
    /Phase 2 \(Consolidation\)/i.test(text)
  )
}
