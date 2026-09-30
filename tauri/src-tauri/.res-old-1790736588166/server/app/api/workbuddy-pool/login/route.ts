import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { beginPoolLogin, pollPoolLogin } from "@/lib/server/workbuddy/login-session"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**发起浏览器授权登录：返回授权 URL与 state。 */
export async function POST() {
 try {
 const payload = await beginPoolLogin()
 return NextResponse.json(payload)
 } catch (error) {
 return jsonError(`发起授权登录失败：${errorMessage(error)}`,400)
 }
}

/**轮询登录态：未完成 `{done:false}`；完成即已写入号池。 */
export async function GET(request: Request) {
 const state = new URL(request.url).searchParams.get("state")?.trim()
 if (!state) return jsonError("缺少 state",400)
 try {
 const result = await pollPoolLogin(state)
 return NextResponse.json(result)
 } catch (error) {
 return jsonError(`轮询登录态失败：${errorMessage(error)}`,400)
 }
}
