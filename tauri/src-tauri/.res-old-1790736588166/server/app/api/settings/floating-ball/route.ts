import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import { updateSnapshot } from "@/lib/server/state-store"
import type { FloatingBallPosition } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface FloatingBallSettingsBody {
  enabled?: unknown
  position?: unknown
}

function normalizePosition(value: unknown): FloatingBallPosition | undefined {
  if (!value || typeof value !== "object") return undefined
  const position = value as Partial<FloatingBallPosition>
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) return undefined
  return {
    x: Math.round(Number(position.x)),
    y: Math.round(Number(position.y)),
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await readJsonBody<FloatingBallSettingsBody>(request)
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined
    const position = normalizePosition(body.position)

    const snapshot = await updateSnapshot((current) => ({
      ...current,
      settings: {
        ...current.settings,
        floatingBallEnabled: enabled ?? current.settings.floatingBallEnabled,
        floatingBallPosition: position ?? current.settings.floatingBallPosition,
      },
    }))

    return NextResponse.json(snapshot)
  } catch (error) {
    return jsonError(`保存悬浮球设置失败：${errorMessage(error)}`, 400)
  }
}
