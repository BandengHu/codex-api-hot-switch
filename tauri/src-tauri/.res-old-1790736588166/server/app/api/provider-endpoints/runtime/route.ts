import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import { resetProviderEndpointRuntime } from "@/lib/server/provider-endpoint-runtime"
import { getSnapshot } from "@/lib/server/state-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{
      providerId?: string
      endpointId?: string
    }>(request)
    if (!body.providerId?.trim() || !body.endpointId?.trim()) {
      return jsonError("缺少 providerId 或 endpointId", 400)
    }
    await resetProviderEndpointRuntime(body.providerId.trim(), body.endpointId.trim())
    return NextResponse.json(await getSnapshot())
  } catch (error) {
    return jsonError(`重置端点状态失败：${errorMessage(error)}`, 400)
  }
}
