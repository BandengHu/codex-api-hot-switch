import { authRequiredResponse, isAuthorized } from "@/lib/server/access-guard"
import { NextResponse } from "next/server"
import { buildCodexDesktopModelLabelsResponse } from "@/lib/server/codex-model-catalog"
import { errorMessage, jsonError } from "@/lib/server/http"
import { getSnapshot } from "@/lib/server/state-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  if (!(await isAuthorized(request))) return authRequiredResponse()
  try {
    return NextResponse.json(buildCodexDesktopModelLabelsResponse(await getSnapshot()))
  } catch (error) {
    return jsonError(`读取 Codex 桌面端模型标签失败：${errorMessage(error)}`)
  }
}
