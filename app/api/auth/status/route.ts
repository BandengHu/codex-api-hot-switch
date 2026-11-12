import { accessAuthStatus } from "@/lib/server/access-auth"
import { isAuthorized, isApiKeyAuthorized } from "@/lib/server/access-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return Response.json({
    authenticated: await isAuthorized(request),
    apiKeyAuthorized: await isApiKeyAuthorized(request),
    ...(await accessAuthStatus()),
  })
}

