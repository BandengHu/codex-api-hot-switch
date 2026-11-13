import { accessAuthStatus } from "@/lib/server/account-auth"
import { accountDataDirPath } from "@/lib/server/accounts-store"
import {
  accessAuthRequired,
  accountFromRequest,
  isApiKeyAuthorized,
} from "@/lib/server/access-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  if (!accessAuthRequired()) {
    return Response.json({
      authenticated: true,
      apiKeyAuthorized: true,
      localMode: true,
      configured: false,
      sessionTtlSeconds: 0,
    })
  }
  const context = await accountFromRequest(request)
  return Response.json({
    authenticated: Boolean(context),
    apiKeyAuthorized: await isApiKeyAuthorized(request),
    localMode: false,
    account: context
      ? {
          id: context.account.id,
          username: context.account.username,
          role: context.account.role,
        }
      : null,
    ...(context
      ? await accessAuthStatus(accountDataDirPath(context.account.id))
      : { configured: false, updatedAt: "", sessionTtlSeconds: 0 }),
  })
}

