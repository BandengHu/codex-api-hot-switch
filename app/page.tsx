import { AppRoot } from "@/components/app-root"
import { resolveView } from "@/lib/console-views"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { ACCESS_COOKIE_NAME } from "@/lib/server/account-auth"
import { accountFromRequest, accessAuthRequired } from "@/lib/server/access-guard"
import { runWithAccountDataDir } from "@/lib/server/data-root"
import { getSnapshot } from "@/lib/server/state-store"

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const cookieStore = await cookies()
  const token = cookieStore.get(ACCESS_COOKIE_NAME)?.value ?? ""
  const params = searchParams ? await searchParams : {}
  const serverMode = accessAuthRequired()
  const view = resolveView(params.view, serverMode)

  if (!serverMode) {
    return (
      <AppRoot
        initialView={view}
        serverMode={false}
        initialSnapshot={await getSnapshot()}
      />
    )
  }

  const request = new Request("http://localhost/", {
    headers: token ? { cookie: `${ACCESS_COOKIE_NAME}=${token}` } : {},
  })
  const context = await accountFromRequest(request)
  if (!context) redirect("/login")

  // 服务端渲染时先绑定账号目录，首屏快照就是该账号自己的配置。
  const snapshot = await runWithAccountDataDir(context.dataDir, () => getSnapshot())
  return <AppRoot initialView={view} serverMode initialSnapshot={snapshot} />
}
