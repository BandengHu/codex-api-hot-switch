import { accessAuthStatus, rotateAccountApiKey } from "@/lib/server/account-auth"
import { accountFromRequest, withAccountContext } from "@/lib/server/access-guard"
import { jsonError } from "@/lib/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** 只轮换当前登录账号自己的 API Key，不影响其他账号。 */
export async function POST(request: Request) {
  const context = await accountFromRequest(request)
  if (!context) return jsonError("需要先登录或提供当前 API Key", 401)
  if (context.account.status !== "active") {
    return jsonError("账号未启用，无法轮换 Key", 403)
  }
  return withAccountContext(context, async () => {
    const apiKey = await rotateAccountApiKey(context.dataDir)
    return Response.json(
      { ok: true, apiKey, ...(await accessAuthStatus(context.dataDir)) },
      { headers: { "cache-control": "no-store" } },
    )
  })
}
