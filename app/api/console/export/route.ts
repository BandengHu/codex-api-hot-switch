import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { exportSnapshotText } from "@/lib/server/state-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return new NextResponse(await exportSnapshotText(), {
      headers: {
        "content-disposition": 'attachment; filename="codex-hotswitch-config.json"',
        "content-type": "application/json; charset=utf-8",
      },
    })
  } catch (error) {
    return jsonError(`导出配置失败：${errorMessage(error)}`)
  }
}
