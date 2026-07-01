import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import { runModelTest } from "@/lib/server/model-test"
import type { Model, Provider, ReasoningEffort } from "@/lib/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const { provider, model, reasoning } = await readJsonBody<{
      provider?: Provider
      model?: Model
      reasoning?: ReasoningEffort
    }>(request)
    if (!provider) return jsonError("缺少 provider", 400)
    if (!model) return jsonError("缺少 model", 400)
    return NextResponse.json(await runModelTest({ provider, model, reasoning }))
  } catch (error) {
    return jsonError(`测试模型失败：${errorMessage(error)}`, 400)
  }
}
