import { authRequiredResponse, runAuthorized } from "@/lib/server/access-guard"
import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { readPoolAccount } from "@/lib/server/workbuddy/task-pool-store"
import { fetchGrowthStreak } from "@/lib/server/workbuddy/task-api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ uid: string }> }

export async function GET(request: Request, context: RouteContext) {
  const result = await runAuthorized(request, async () => {
    try {
      const { uid } = await context.params
      const account = await readPoolAccount(uid)
      const streak = await fetchGrowthStreak(account)
      return NextResponse.json({ uid, streak })
    } catch (error) {
      return jsonError(`读取连登状态失败：${errorMessage(error)}`)
    }
  })
  return result ?? authRequiredResponse()
}

