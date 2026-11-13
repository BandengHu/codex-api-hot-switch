import { authRequiredResponse, runAuthorized } from "@/lib/server/access-guard"
import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
  readGlobalPoolAccount,
  removeGlobalAccount,
  setActiveGlobalPoolAccount,
  setGlobalAccountDisabled,
  unbanGlobalPoolAccount,
} from "@/lib/server/workbuddy/global-pool-store"
import { fetchBalance } from "@/lib/server/workbuddy/task-api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ uid: string }> }

/** 单个国际版账号的启停 / 移除 / 余额刷新 / 设为转发账号。 */
export async function POST(request: Request, context: RouteContext) {
  const result = await runAuthorized(request, async () => {
    const { uid } = await context.params
    try {
    const body = await readJsonBody<{ action?: string }>(request)
    const action = body.action?.trim()
    if (!action) return jsonError("缺少 action", 400)

    if (action === "disable" || action === "enable") {
      await setGlobalAccountDisabled(uid, action === "disable")
      return NextResponse.json({ ok: true })
    }
    if (action === "unban") {
      await unbanGlobalPoolAccount(uid)
      return NextResponse.json({ ok: true })
    }
    if (action === "remove") {
      await removeGlobalAccount(uid)
      return NextResponse.json({ ok: true })
    }
    if (action === "balance") {
      const account = await readGlobalPoolAccount(uid)
      return NextResponse.json({ ok: true, balance: await fetchBalance(account) })
    }
    // 指定转发用哪个国际版账号（国内站号池同一套语义：只手动指定，不自动轮转）。
    if (action === "active") {
      const activeUid = await setActiveGlobalPoolAccount(uid)
      return NextResponse.json({ ok: true, activeUid })
    }
    return jsonError(`未知 action：${action}`, 400)
    } catch (error) {
      return jsonError(`操作失败：${errorMessage(error)}`)
    }
  })
  return result ?? authRequiredResponse()
}
