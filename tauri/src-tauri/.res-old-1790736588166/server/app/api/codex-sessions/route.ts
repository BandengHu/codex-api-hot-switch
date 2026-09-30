import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
  clearCodexSessionBackups,
  deleteCodexSessions,
  getCodexSessionSyncStatus,
  syncCodexSessions,
} from "@/lib/server/codex-session-sync"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return NextResponse.json(await getCodexSessionSyncStatus())
  } catch (error) {
    return jsonError(`读取同步会话状态失败：${errorMessage(error)}`)
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{
      action?: string
      threadIds?: string[]
    }>(request)
    if (body.action === "sync") return NextResponse.json(await syncCodexSessions())
    if (body.action === "delete-many") {
      return NextResponse.json(await deleteCodexSessions(body.threadIds || []))
    }
    if (body.action === "clear-backups") {
      return NextResponse.json(await clearCodexSessionBackups())
    }
    return jsonError("未知同步会话动作", 400)
  } catch (error) {
    return jsonError(`同步会话操作失败：${errorMessage(error)}`, 400)
  }
}
