import { authRequiredResponse, runAuthorized } from "@/lib/server/access-guard"
import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { updateSnapshot } from "@/lib/server/state-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const result = await runAuthorized(request, async () => {
    try {
      const snapshot = await updateSnapshot((current) => ({
        ...current,
        settings: {
          ...current.settings,
          tokenStatsResetAt: new Date().toISOString(),
        },
      }))
      return NextResponse.json(snapshot)
    } catch (error) {
      return jsonError(`重置 token 累计失败：${errorMessage(error)}`, 400)
    }
  })
  return result ?? authRequiredResponse()
}
