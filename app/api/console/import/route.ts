import { NextResponse } from "next/server"
import { errorMessage, jsonError } from "@/lib/server/http"
import { importSnapshotText } from "@/lib/server/state-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    return NextResponse.json(await importSnapshotText(await request.text()))
  } catch (error) {
    return jsonError(`导入配置失败：${errorMessage(error)}`, 400)
  }
}
