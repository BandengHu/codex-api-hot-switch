import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import { runProviderTest } from "@/lib/server/provider-test"
import type { Provider } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const { provider } = await readJsonBody<{ provider: Provider }>(request)
    if (!provider) return jsonError("缺少 provider", 400)
    return NextResponse.json(await runProviderTest(provider))
  } catch (error) {
    return jsonError(`测试供应商失败：${errorMessage(error)}`, 400)
  }
}
