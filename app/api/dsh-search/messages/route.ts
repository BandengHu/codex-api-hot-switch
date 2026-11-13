import {
  accessAuthRequired,
  accountFromApiKey,
  apiKeyRequiredResponse,
  authRequiredResponse,
  isAuthorized,
  withAccountContext,
} from "@/lib/server/access-guard"
import {
  dshSearchErrorResponse,
  executeDshSearchMessages,
} from "@/lib/server/dsh-search/messages"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  if (accessAuthRequired()) {
    const context = await accountFromApiKey(request.headers)
    if (!context) return apiKeyRequiredResponse()
    return withAccountContext(context, () => handlePost(request))
  }
  return handlePost(request)
}

async function handlePost(request: Request) {
  try {
    return Response.json(
      await executeDshSearchMessages(await request.json(), request.signal),
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    )
  } catch (error) {
    return dshSearchErrorResponse(error)
  }
}

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) return authRequiredResponse()
  return Response.json({
    object: "dsh-search-messages-endpoint",
    provider: "switchgate",
    messagePath: "/api/dsh-search/messages",
    baseURL: "/api/dsh-search",
  })
}
