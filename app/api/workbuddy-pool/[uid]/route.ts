import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
 readPoolAccount,
 removePoolAccount,
 setPoolAccountDisabled,
} from "@/lib/server/workbuddy/task-pool-store"
import {
listGrowthTasks,
claimGrowthReward,
WorkbuddyTaskApiError,
} from "@/lib/server/workbuddy/task-api"
import {
 runChat5Automation,
 runFirstBuddyAutomation,
 runTaskAutomation,
} from "@/lib/server/workbuddy/task-automation"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ uid: string }> }

export async function GET(_request: Request, context: RouteContext) {
 const { uid } = await context.params
 try {
 const account = await readPoolAccount(uid)
 const tasks = await listGrowthTasks(account)
 return NextResponse.json({ uid, tasks })
 } catch (error) {
 return jsonError(`读取任务失败：${errorMessage(error)}`)
 }
}

export async function POST(request: Request, context: RouteContext) {
 const { uid } = await context.params
 try {
 const body = await readJsonBody<{ action?: string; taskCode?: string }>(request)
 const action = body.action?.trim()
 if (!action) return jsonError("缺少 action",400)

 if (action === "disable" || action === "enable") {
 await setPoolAccountDisabled(uid, action === "disable")
 return NextResponse.json({ ok: true })
 }
 if (action === "remove") {
 await removePoolAccount(uid)
 return NextResponse.json({ ok: true })
 }

 const account = await readPoolAccount(uid)
 if (action === "claim") {
 const taskCode = body.taskCode?.trim()
 if (!taskCode) return jsonError("缺少 taskCode",400)
 const result = await claimGrowthReward(account, taskCode)
 return NextResponse.json({ ok: true, result })
 }
if (action === "automate") {
const taskCode = body.taskCode?.trim()
if (!taskCode) return jsonError("缺少 taskCode",400)
 const result =
 taskCode === "chat_5"
 ? await runChat5Automation(account)
 : taskCode === "first_buddy"
 ? await runFirstBuddyAutomation(account)
 : await runTaskAutomation(account, taskCode)
return NextResponse.json({ ok: true, result })
}
 return jsonError(`未知 action：${action}`,400)
 } catch (error) {
 return jsonError(`操作失败：${errorMessage(error)}`)
 }
}
