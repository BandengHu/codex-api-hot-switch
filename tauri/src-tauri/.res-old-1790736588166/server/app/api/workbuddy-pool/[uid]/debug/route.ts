import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { readPoolAccount } from "@/lib/server/workbuddy/task-pool-store"
import { fetchGrowthStreak } from "@/lib/server/workbuddy/task-api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ uid: string }> }

export async function GET(_request: Request, context: RouteContext) {
 const { uid } = await context.params
 try {
 const account = await readPoolAccount(uid)
 const streak = await fetchGrowthStreak(account)
 return NextResponse.json({ uid, streak })
 } catch (error) {
 return jsonError(`读取连登状态失败：${errorMessage(error)}`)
 }
}

