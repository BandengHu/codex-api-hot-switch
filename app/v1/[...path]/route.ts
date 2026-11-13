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

/**
 * 模型调用入口。
 *
 * 服务器模式必须带调用方自己的 API Key：先用 Key 定位账号，
 * 再把整段代理逻辑放进该账号的数据上下文，配置与号池都只属于这个账号。
 */
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
    return handleProxyPost(["v1", ...path], request)
  })
}

export async function GET(request: Request, context: RouteContext) {
  return withApiAccount(request, async () => {
    const { path } = await context.params
    return handleProxyGet(["v1", ...path], request)
  })
}
