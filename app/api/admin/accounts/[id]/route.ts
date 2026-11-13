import { NextResponse } from "next/server"
import { runAdmin } from "@/lib/server/admin-guard"
import {
  accountDataDirPath,
  findAccountById,
  toPublicAccount,
  updateAccount,
  type AccountStatus,
} from "@/lib/server/accounts-store"
import { ensureAccountAuth } from "@/lib/server/account-auth"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { readJsonBody } from "@/lib/server/http"
import { normalizeSnapshot } from "@/lib/server/state-store"
import { blankSnapshot } from "@/lib/server/blank-snapshot"
import { writeFile } from "node:fs/promises"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface RouteContext {
  params: Promise<{ id: string }>
}

const STATUS_VALUES = new Set<AccountStatus>(["pending", "active", "disabled"])

/**
 * 审批 / 停用 / 恢复账号。
 *
 * 审批通过时才创建该账号的空白配置与独立 API Key：
 * 未审批账号不占磁盘，也不会提前拿到可用的调用凭证。
 */
export async function PATCH(request: Request, context: RouteContext) {
  const result = await runAdmin(request, async (adminAccount) => {
    const { id } = await context.params
    const body = await readJsonBody<{ status?: unknown }>(request)
    if (typeof body.status !== "string" || !STATUS_VALUES.has(body.status as AccountStatus)) {
      return NextResponse.json({ error: "status 只能是 pending / active / disabled" }, { status: 400 })
    }
    const target = await findAccountById(id)
    if (!target) return NextResponse.json({ error: "账号不存在" }, { status: 404 })

    const status = body.status as AccountStatus
    if (target.role === "admin" && status === "disabled" && target.id === adminAccount?.id) {
      return NextResponse.json({ error: "不能停用当前登录的管理员账号" }, { status: 400 })
    }

    let apiKey: string | undefined
    if (status === "active") {
      const dataDir = accountDataDirPath(target.id)
      await mkdir(dataDir, { recursive: true })
      const statePath = join(dataDir, "hot-switch-state.json")
      const { readFile } = await import("node:fs/promises")
      const exists = await readFile(statePath, "utf8").catch(() => null)
      if (!exists) {
        const snapshot = normalizeSnapshot(blankSnapshot())
        const {
          logs: _logs,
          tokenStats: _tokenStats,
          endpointStates: _endpointStates,
          ...config
        } = snapshot
        await writeFile(statePath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
      }
      const auth = await ensureAccountAuth(dataDir)
      apiKey = auth.apiKey
    }

    const updated = await updateAccount(target.id, {
      status,
      ...(adminAccount ? { approvedBy: adminAccount.username } : {}),
    })
    return NextResponse.json({
      ok: true,
      account: toPublicAccount(updated),
      // 只在“首次审批生成 Key”时返回一次，之后只能由账号自己轮换。
      ...(apiKey ? { apiKey } : {}),
    })
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status })
  }
  return result.value
}
