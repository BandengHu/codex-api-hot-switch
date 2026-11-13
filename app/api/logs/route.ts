import { authRequiredResponse, isAuthorized } from "@/lib/server/access-guard"
import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { getSnapshot } from "@/lib/server/state-store"
import { getRequestLogs } from "@/lib/server/telemetry-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) return authRequiredResponse()
  try {
    const snapshot = await getSnapshot()
    return NextResponse.json(await getRequestLogs(snapshot.settings))
  } catch (error) {
    return jsonError(`读取请求日志失败：${errorMessage(error)}`)
  }
}
