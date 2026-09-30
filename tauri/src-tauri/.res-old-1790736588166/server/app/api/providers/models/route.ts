import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import { discoverProviderModels } from "@/lib/server/provider-model-discovery"
import type { Provider } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const { provider } = await readJsonBody<{ provider: Provider }>(request)
    if (!provider) return jsonError("缺少 provider", 400)
    return NextResponse.json(await discoverProviderModels(provider))
  } catch (error) {
    return jsonError(`获取供应商模型失败：${errorMessage(error)}`, 400)
  }
}
