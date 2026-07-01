import { AppRoot } from "@/components/app-root"
import type { ViewKey } from "@/components/sidebar"

const DEFAULT_VIEW: ViewKey = "codex-desktop"

const VIEW_KEYS = new Set<ViewKey>([
  "codex-desktop",
  "dashboard",
  "providers",
  "models",
  "switch",
  "token-stats",
  "logs",
  "codex-sessions",
  "wecom-bridge",
  "settings",
])

function parseView(value: unknown): ViewKey {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === "string" && VIEW_KEYS.has(raw as ViewKey)
    ? (raw as ViewKey)
    : DEFAULT_VIEW
}

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = searchParams ? await searchParams : {}
  return <AppRoot initialView={parseView(params.view)} />
}
