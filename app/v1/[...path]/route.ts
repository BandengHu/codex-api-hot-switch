import { handleProxyGet, handleProxyPost } from "@/lib/server/proxy/pipeline"
import { apiKeyRequiredResponse, isApiKeyAuthorized } from "@/lib/server/access-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<{ path: string[] }>
}

export async function POST(request: Request, context: RouteContext) {
  if (!(await isApiKeyAuthorized(request))) return apiKeyRequiredResponse()
  const { path } = await context.params
  return handleProxyPost(["v1", ...path], request)
}

export async function GET(request: Request, context: RouteContext) {
  if (!(await isApiKeyAuthorized(request))) return apiKeyRequiredResponse()
  const { path } = await context.params
  return handleProxyGet(["v1", ...path], request)
}
