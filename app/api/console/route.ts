import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import { getSnapshot, saveSnapshot } from "@/lib/server/state-store"
import { autostartWecomBridgeServeIfEnabled } from "@/lib/server/wecom-bridge"
import type { ConsoleSnapshot } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    await autostartWecomBridgeServeIfEnabled()
    return NextResponse.json(await getSnapshot())
  } catch (error) {
    return jsonError(`读取配置失败：${errorMessage(error)}`)
  }
}

export async function PUT(request: Request) {
  try {
    const snapshot = await readJsonBody<ConsoleSnapshot>(request)
    return NextResponse.json(await saveSnapshot(snapshot))
  } catch (error) {
    return jsonError(`保存配置失败：${errorMessage(error)}`, 400)
  }
}
