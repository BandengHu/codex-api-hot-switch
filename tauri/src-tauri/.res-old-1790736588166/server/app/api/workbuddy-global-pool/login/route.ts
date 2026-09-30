import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import {
  beginGlobalPoolLogin,
  pollGlobalPoolLogin,
} from "@/lib/server/workbuddy/global-login-session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** 发起国际版浏览器授权登录：返回授权 URL 与 state。 */
export async function POST() {
  try {
    return NextResponse.json(await beginGlobalPoolLogin())
  } catch (error) {
    return jsonError(`发起国际版授权登录失败：${errorMessage(error)}`, 400)
  }
}

/** 轮询登录态：未完成 `{done:false}`；完成即已写入国际版号池。 */
export async function GET(request: Request) {
  const state = new URL(request.url).searchParams.get("state")?.trim()
  if (!state) return jsonError("缺少 state", 400)
  try {
    return NextResponse.json(await pollGlobalPoolLogin(state))
  } catch (error) {
    return jsonError(`轮询国际版登录态失败：${errorMessage(error)}`, 400)
  }
}
