import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import { getSnapshot } from "@/lib/server/state-store"
import {
  getCodexDesktopModelWhitelistStatus,
  injectCodexDesktopModelWhitelist,
  launchCodexDesktopWithModelWhitelist,
  restartCodexDesktopWithModelWhitelist,
} from "@/lib/server/codex-desktop-model-whitelist-runner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const snapshot = await getSnapshot()
    return NextResponse.json(await getCodexDesktopModelWhitelistStatus(snapshot.settings))
  } catch (error) {
    return jsonError(`读取 Codex 模型白名单状态失败：${errorMessage(error)}`)
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ action?: string }>(request)
    const snapshot = await getSnapshot()
    if (body.action === "inject") {
      return NextResponse.json(await injectCodexDesktopModelWhitelist(snapshot.settings))
    }
    if (body.action === "launch") {
      return NextResponse.json(await launchCodexDesktopWithModelWhitelist(snapshot.settings))
    }
    if (body.action === "restart") {
      return NextResponse.json(await restartCodexDesktopWithModelWhitelist(snapshot.settings))
    }
    return jsonError("未知 Codex 模型白名单动作", 400)
  } catch (error) {
    return jsonError(`处理 Codex 模型白名单失败：${errorMessage(error)}`, 400)
  }
}
