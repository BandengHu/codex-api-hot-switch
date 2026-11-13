import { authRequiredResponse, runAuthorized } from "@/lib/server/access-guard"
import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { getTokenStats } from "@/lib/server/telemetry-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const result = await runAuthorized(request, async () => {
    try {
      return NextResponse.json(await getTokenStats())
    } catch (error) {
      return jsonError(`读取 token 统计失败：${errorMessage(error)}`)
    }
  })
  return result ?? authRequiredResponse()
}
