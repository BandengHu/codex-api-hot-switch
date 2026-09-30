import { handleProxyGet, handleProxyPost } from "@/lib/server/proxy/pipeline"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<{ path: string[] }>
}

export async function POST(request: Request, context: RouteContext) {
  const { path } = await context.params
  return handleProxyPost(path, request)
}

export async function GET(request: Request, context: RouteContext) {
  const { path } = await context.params
  return handleProxyGet(path, request)
}
