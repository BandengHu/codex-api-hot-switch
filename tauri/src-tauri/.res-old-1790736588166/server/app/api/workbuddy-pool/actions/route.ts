import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { TASK_ACTIONS } from "@/lib/server/workbuddy/actions-registry"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**可自动完成的任务清单（前端据此标注哪些任务能一键完成）。 */
export async function GET() {
 try {
 return NextResponse.json({
 actions: TASK_ACTIONS.map((action) => ({
 taskCode: action.taskCode,
 desc: action.desc,
 attempt: action.attempt === true,
 })),
 })
 } catch (error) {
 return jsonError(`读取任务动作表失败：${errorMessage(error)}`)
 }
}

