import { handleProxyGet, handleProxyPost } from "@/lib/server/proxy/pipeline"
import {
  accessAuthRequired,
  accountFromApiKey,
  apiKeyRequiredResponse,
  withAccountContext,
} from "@/lib/server/access-guard"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<{ path: string[] }>
}

async function withApiAccount<T>(
  request: Request,
  handler: () => Promise<T>,
): Promise<T | Response> {
  if (!accessAuthRequired()) return handler()
  const context = await accountFromApiKey(request.headers)
  if (!context) return apiKeyRequiredResponse()
  return withAccountContext(context, handler)
}

export async function POST(request: Request, context: RouteContext) {
  return withApiAccount(request, async () => {
    const { path } = await context.params
    return handleProxyPost(path, request)
  })
}

export async function GET(request: Request, context: RouteContext) {
  return withApiAccount(request, async () => {
    const { path } = await context.params
    return handleProxyGet(path, request)
  })
}
