import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
  GLOBAL_WORKBUDDY_ORIGIN,
  GLOBAL_WORKBUDDY_PLATFORM,
} from "@/lib/server/workbuddy/global-oauth"
import {
  activeGlobalUidOf,
  importGlobalAccount,
  listGlobalPoolEntries,
  readGlobalPoolAccount,
  readGlobalPoolState,
  syncGlobalPoolFromDisk,
} from "@/lib/server/workbuddy/global-pool-store"
import { accountBanOf } from "@/lib/server/workbuddy/pool-selection"
import type { WorkbuddyAccountBan } from "@/lib/server/workbuddy/account-ban"
import { fetchBalance } from "@/lib/server/workbuddy/task-api"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * WorkBuddy 国际版号池。
 *
 * 与国内站号池（`/api/workbuddy-pool`）完全独立：独立目录、独立凭据、独立登录会话。
 * 这里没有「本机账号」概念，账号全部来自授权登录或手工导入。
 */

interface GlobalPoolEntryWithBalance {
  uid: string
  nickname: string
  domain: string
  disabled: boolean
  active: boolean
  accountBan?: WorkbuddyAccountBan
  balance?: { remain: number; used: number; size: number; packs: number }
  balanceError?: string
}

export async function GET() {
  try {
    await syncGlobalPoolFromDisk()
    const entries = await listGlobalPoolEntries()
    // 生效账号：显式选中的优先，否则回落池里第一个可用账号；池空时没有生效账号。
    const state = await readGlobalPoolState()
    let activeUid = ""
    try {
      activeUid = activeGlobalUidOf(state)
    } catch {
      activeUid = ""
    }
    const enriched: GlobalPoolEntryWithBalance[] = []
    for (const entry of entries) {
      const item: GlobalPoolEntryWithBalance = {
        uid: entry.uid,
        nickname: entry.nickname,
        domain: entry.domain,
        disabled: entry.disabled,
        active: entry.uid === activeUid,
      }
      const accountBan = accountBanOf(state, entry.uid)
      if (accountBan) item.accountBan = accountBan
      if (!entry.disabled && !accountBan) {
        try {
          const account = await readGlobalPoolAccount(entry.uid)
          item.balance = await fetchBalance(account)
          if (!item.nickname && account.nickname) item.nickname = account.nickname
        } catch (error) {
          item.balanceError = errorMessage(error)
        }
      }
      enriched.push(item)
    }
    return NextResponse.json({
      entries: enriched,
      activeUid,
      realm: {
        origin: GLOBAL_WORKBUDDY_ORIGIN,
        platform: GLOBAL_WORKBUDDY_PLATFORM,
      },
    })
  } catch (error) {
    return jsonError(`读取国际版号池失败：${errorMessage(error)}`)
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ credentials?: string }>(request)
    if (!body.credentials?.trim()) return jsonError("缺少凭据内容", 400)
    const entry = await importGlobalAccount(body.credentials.trim())
    return NextResponse.json({ ok: true, entry })
  } catch (error) {
    return jsonError(`导入失败：${errorMessage(error)}`, 400)
  }
}
