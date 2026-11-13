import { NextResponse } from "next/server"
import { runAdmin } from "@/lib/server/admin-guard"
import {
  listAccounts,
  toPublicAccount,
} from "@/lib/server/accounts-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** 管理员查看全部账号（含待审批），不返回任何密码或密钥字段。 */
export async function GET(request: Request) {
  const result = await runAdmin(request, async () => {
    const accounts = await listAccounts()
    return NextResponse.json({
      accounts: accounts.map(toPublicAccount),
      pending: accounts.filter((account) => account.status === "pending").length,
    })
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status })
  }
  return result.value
}
