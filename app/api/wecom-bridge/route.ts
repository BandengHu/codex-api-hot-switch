import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
  getWecomBridgeStatus,
  startWecomBridgeServe,
  stopWecomBridgeServe,
  updateWecomBridgeSettings,
} from "@/lib/server/wecom-bridge"
import type { WecomBridgeSettings } from "@/lib/wecom-bridge-types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Action =
  | "save-settings"
  | "serve-start"
  | "serve-stop"

export async function GET() {
  try {
    return NextResponse.json(await getWecomBridgeStatus())
  } catch (error) {
    return jsonError(`读取企业微信机器人状态失败：${errorMessage(error)}`)
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{
      action?: Action
      settings?: Partial<WecomBridgeSettings>
    }>(request)
    const action = body.action
    if (action === "save-settings") {
      const current = await getWecomBridgeStatus()
      return NextResponse.json(await updateWecomBridgeSettings({
        ...current.settings,
        ...(body.settings ?? {}),
      }))
    }
    if (action === "serve-start") {
      return NextResponse.json(await startWecomBridgeServe())
    }
    if (action === "serve-stop") {
      return NextResponse.json(await stopWecomBridgeServe())
    }
    return jsonError("未知企业微信机器人操作", 400)
  } catch (error) {
    return jsonError(`企业微信机器人操作失败：${errorMessage(error)}`, 400)
  }
}
