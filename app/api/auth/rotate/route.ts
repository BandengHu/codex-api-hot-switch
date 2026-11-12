import { accessAuthStatus, rotateApiKey } from "@/lib/server/access-auth"
import { isAuthorized } from "@/lib/server/access-guard"
import { jsonError } from "@/lib/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  if (!(await isAuthorized(request))) return jsonError("需要先登录或提供当前 API Key", 401)
  const apiKey = await rotateApiKey()
  return Response.json(
    { ok: true, apiKey, ...(await accessAuthStatus()) },
    { headers: { "cache-control": "no-store" } },
  )
}

