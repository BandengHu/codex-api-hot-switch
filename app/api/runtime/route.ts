import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import { updateSnapshot } from "@/lib/server/state-store"
import type { ReasoningEffort } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const REASONING_VALUES = new Set<ReasoningEffort>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "auto",
])

interface RuntimePatchBody {
  activeProviderId?: unknown
  activeModelId?: unknown
  reasoning?: unknown
  takeover?: unknown
}

function stringValue(value: unknown, field: string) {
  if (typeof value === "string" && value.trim()) return value
  throw new Error(`${field} 不能为空`)
}

export async function PATCH(request: Request) {
  try {
    const body = await readJsonBody<RuntimePatchBody>(request)
    const providerId =
      body.activeProviderId == null
        ? undefined
        : stringValue(body.activeProviderId, "供应商")
    const modelId =
      body.activeModelId == null ? undefined : stringValue(body.activeModelId, "模型")
    const reasoning =
      body.reasoning == null
        ? undefined
        : REASONING_VALUES.has(body.reasoning as ReasoningEffort)
          ? (body.reasoning as ReasoningEffort)
          : undefined
    const takeover =
      body.takeover === "active" || body.takeover === "paused"
        ? body.takeover
        : undefined

    if (body.reasoning != null && !reasoning) throw new Error("推理强度无效")

    const snapshot = await updateSnapshot((current) => {
      const nextProviderId = providerId ?? current.runtime.activeProviderId
      const nextModelId = modelId ?? current.runtime.activeModelId
      const provider = current.providers.find((item) => item.id === nextProviderId)
      const model = current.models.find((item) => item.id === nextModelId)

      if (!provider) throw new Error("供应商不存在")
      if (!model) throw new Error("模型不存在")
      if (model.providerId !== provider.id) {
        throw new Error("模型不属于所选供应商")
      }

      return {
        ...current,
        runtime: {
          ...current.runtime,
          activeProviderId: nextProviderId,
          activeModelId: nextModelId,
          reasoning: reasoning ?? current.runtime.reasoning,
          takeover: takeover ?? current.runtime.takeover,
        },
        settings:
          takeover == null
            ? current.settings
            : {
                ...current.settings,
                takeoverEnabled: takeover === "active",
              },
      }
    })

    return NextResponse.json(snapshot)
  } catch (error) {
    return jsonError(`切换失败：${errorMessage(error)}`, 400)
  }
}
