import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
  getCodexDesktopPluginStatus,
  repairCodexDesktopPlugins,
} from "@/lib/server/codex-desktop-plugin-runner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return NextResponse.json(await getCodexDesktopPluginStatus())
  } catch (error) {
    return jsonError(`读取 Codex 桌面端插件状态失败：${errorMessage(error)}`)
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ action?: string }>(request)
    if (body.action === "repair") {
      return NextResponse.json(await repairCodexDesktopPlugins())
    }
    return jsonError("未知 Codex 桌面端插件动作", 400)
  } catch (error) {
    return jsonError(`修复 Codex 桌面端插件失败：${errorMessage(error)}`, 400)
  }
}
