import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { getSnapshot } from "@/lib/server/state-store"
import { readRequestLogDetail } from "@/lib/server/request-log-details"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    const snapshot = await getSnapshot()
    const log = snapshot.logs.find((item) => item.id === id)
    if (!log) return jsonError("日志不存在", 404)
    return NextResponse.json(await readRequestLogDetail(log))
  } catch (error) {
    return jsonError(`读取日志详情失败：${errorMessage(error)}`)
  }
}
