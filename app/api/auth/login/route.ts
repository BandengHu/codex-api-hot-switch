import { issueSessionCookie, verifyApiKey } from "@/lib/server/access-auth"
import { jsonError, readJsonBody } from "@/lib/server/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface LoginBody {
  apiKey?: unknown
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<LoginBody>(request)
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
    if (!apiKey || !(await verifyApiKey(apiKey))) {
      return jsonError("API Key 无效", 401)
    }
    const session = await issueSessionCookie()
    return Response.json(
      { ok: true, expiresAt: session.expiresAt },
      {
        headers: {
          "set-cookie": session.cookie,
          "cache-control": "no-store",
        },
      },
    )
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : String(error), 400)
  }
}

