import { AppRoot } from "@/components/app-root"
import type { ViewKey } from "@/components/sidebar"
import { redirect } from "next/navigation"
import { cookies, headers } from "next/headers"
import { ACCESS_COOKIE_NAME, readSessionCookie } from "@/lib/server/access-auth"
import { isApiKeyAuthorizedHeaders } from "@/lib/server/access-guard"

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
  "workbuddy-pool",
  "workbuddy-global-pool",
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
  const cookieStore = await cookies()
  const token = cookieStore.get(ACCESS_COOKIE_NAME)?.value ?? ""
  const session = token
    ? await readSessionCookie(`${ACCESS_COOKIE_NAME}=${token}`)
    : null
  // 控制台页面允许服务器 API Key 直接打开；登录 Cookie 只影响设置页。
  const apiKeyAuthorized = await isApiKeyAuthorizedHeaders(await headers())
  if (!session && !apiKeyAuthorized) redirect("/login")
  const params = searchParams ? await searchParams : {}
  return <AppRoot initialView={parseView(params.view)} />
}
