import { authRequiredResponse, isAuthorized } from "@/lib/server/access-guard"
import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { readRequestLogDetail } from "@/lib/server/request-log-details"
import { findRequestLog } from "@/lib/server/telemetry-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(request: Request, context: RouteContext) {
  if (!(await isAuthorized(request))) return authRequiredResponse()
  try {
    const { id } = await context.params
    const log = await findRequestLog(id)
    if (!log) return jsonError("日志不存在", 404)
    return NextResponse.json(await readRequestLogDetail(log))
  } catch (error) {
    return jsonError(`读取日志详情失败：${errorMessage(error)}`)
  }
}
