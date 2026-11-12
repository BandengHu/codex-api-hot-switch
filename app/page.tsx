import { AppRoot } from "@/components/app-root"
import { resolveView } from "@/lib/console-views"
import { redirect } from "next/navigation"
import { cookies, headers } from "next/headers"
import { ACCESS_COOKIE_NAME, readSessionCookie } from "@/lib/server/access-auth"
import { isApiKeyAuthorizedHeaders } from "@/lib/server/access-guard"

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
  const serverMode = process.env.CODEX_HOT_SWITCH_SERVER_UI === "1"
  return (
    <AppRoot
      initialView={resolveView(params.view, serverMode)}
      serverMode={serverMode}
    />
  )
}
