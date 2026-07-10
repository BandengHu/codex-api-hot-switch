import type { Model } from "@/lib/types"

export const CODEX_AUTO_MODEL_SLUG = "switchgate__auto"
export const CODEX_AUTO_MODEL_DISPLAY_NAME = "自动"
export const CODEX_SUBAGENT_ROLE_COUNT = 4

function routeIdPart(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "model"
  )
}

export function codexRoutedModelSlug(model: Pick<Model, "id">) {
  return `switchgate__${routeIdPart(model.id)}`
}

export function defaultCodexSubagentModelSlugs() {
  return Array.from({ length: CODEX_SUBAGENT_ROLE_COUNT }, () => CODEX_AUTO_MODEL_SLUG)
}
