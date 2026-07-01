import "server-only"

const PROTECTED_TOP_LEVEL_FIELDS = new Set(["model", "stream"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function mergeJsonOverride(
  target: unknown,
  patch: unknown,
  isTopLevel = true,
): { value: unknown; changed: boolean } {
  if (isRecord(target) && isRecord(patch)) {
    let changed = false
    const next: Record<string, unknown> = { ...target }

    for (const [key, patchValue] of Object.entries(patch)) {
      if (isTopLevel && PROTECTED_TOP_LEVEL_FIELDS.has(key)) continue
      if (key in next) {
        const merged = mergeJsonOverride(next[key], patchValue, false)
        next[key] = merged.value
        changed ||= merged.changed
      } else {
        next[key] = patchValue
        changed = true
      }
    }

    return { value: changed ? next : target, changed }
  }

  if (Object.is(target, patch)) return { value: target, changed: false }
  return { value: patch, changed: true }
}

export function applyProviderBodyOverride(body: unknown, bodyOverride: string) {
  const raw = bodyOverride.trim()
  if (!raw) return { body, changed: false }

  let patch: unknown
  try {
    patch = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`供应商请求体覆盖不是有效 JSON：${message}`)
  }

  if (!isRecord(patch)) {
    throw new Error("供应商请求体覆盖必须是 JSON 对象")
  }

  const merged = mergeJsonOverride(body, patch)
  return { body: merged.value, changed: merged.changed }
}
