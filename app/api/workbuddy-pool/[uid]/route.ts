import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
 readPoolAccount,
 removePoolAccount,
 setPoolAccountDisabled,
} from "@/lib/server/workbuddy/task-pool-store"
import { claimGrowthReward, listAllGrowthTasks } from "@/lib/server/workbuddy/task-api"
import { runAllAutomations, runTaskAutomation } from "@/lib/server/workbuddy/task-automation"
import { runDailyRewards } from "@/lib/server/workbuddy/daily-automation"
import { tryLockTaskAccount, unlockTaskAccount } from "@/lib/server/workbuddy/task-lock"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ uid: string }> }

/**
 *「一键全部」的 HTTP兜底超时。
 *
 *照搬上游面板口径：多项任务串联、每项还含真实对话，整轮可能超过5分钟；HTTP侧
 *到点先回504，但后台流水线继续跑完，账号锁由流水线自己释放——期间重复点击会被
 *409挡住，不会出现两轮并发。
 */
const AUTOMATE_ALL_TIMEOUT_MS =5 *60 *1000

export async function GET(_request: Request, context: RouteContext) {
 const { uid } = await context.params
 try {
 const account = await readPoolAccount(uid)
 const tasks = await listAllGrowthTasks(account)
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
 if (action === "daily") {
 //每日领积分（签到/连登兑换/抽奖/礼包/补签）走同一把账号锁：与任务自动化
 //共用配额，不能并发跑。
 if (!tryLockTaskAccount(uid)) {
 return jsonError("该账号有动作正在执行中，请等本轮结束后再试",409)
 }
 try {
 const result = await runDailyRewards(account)
 return NextResponse.json({ ok: true, result })
 } finally {
 unlockTaskAccount(uid)
 }
 }
 if (action !== "automate" && action !== "automate-all") {
 return jsonError(`未知 action：${action}`,400)
 }

 const taskCode = body.taskCode?.trim()
 if (action === "automate" && !taskCode) return jsonError("缺少 taskCode",400)

 // per-account互斥：动作虽幂等，但 expert/skill系每轮含真实对话，并发重跑只会
 //浪费上游配额（上游面板同款口径）。
 if (!tryLockTaskAccount(uid)) {
 return jsonError("该账号有任务动作正在执行中，请等本轮结束后再试",409)
 }

 if (action === "automate") {
 try {
 const result = await runTaskAutomation(account, taskCode as string)
 return NextResponse.json({ ok: true, result })
 } finally {
 unlockTaskAccount(uid)
 }
 }

 //流水线自己持锁到结束（可能长于 HTTP超时），提前返回也不会漏放锁。
 const pipeline = runAllAutomations(account).finally(() => unlockTaskAccount(uid))
 const timedOut = Symbol("timeout")
 let timer: ReturnType<typeof setTimeout> | undefined
 const expiry = new Promise<typeof timedOut>((resolve) => {
 timer = setTimeout(() => resolve(timedOut), AUTOMATE_ALL_TIMEOUT_MS)
 })
 try {
 const raced = await Promise.race([pipeline, expiry])
 if (raced === timedOut) {
 pipeline.catch(() => {
 //超时已返回，后台异常无处上报；锁由 finally释放，不影响下一轮。
 })
 return jsonError("执行超时（任务仍在后台继续，稍后刷新查看进度）",504)
 }
 return NextResponse.json({ ok: true, results: raced })
 } finally {
 if (timer) clearTimeout(timer)
 }
 } catch (error) {
 return jsonError(`操作失败：${errorMessage(error)}`)
 }
}
