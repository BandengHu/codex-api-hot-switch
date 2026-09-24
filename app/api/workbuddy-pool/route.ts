import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
 importPoolAccount,
 listPoolEntries,
 syncPoolFromDisk,
} from "@/lib/server/workbuddy/task-pool-store"
import { fetchBalance } from "@/lib/server/workbuddy/task-api"
import { readPoolAccount } from "@/lib/server/workbuddy/task-pool-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface PoolEntryWithBalance {
 uid: string
 nickname: string
 source: "local" | "file"
 disabled: boolean
 balance?: { remain: number; used: number; size: number; packs: number }
 balanceError?: string
}

export async function GET() {
 try {
 await syncPoolFromDisk()
 const entries = await listPoolEntries()
 const enriched: PoolEntryWithBalance[] = []
 for (const entry of entries) {
 const item: PoolEntryWithBalance = {
 uid: entry.uid,
 nickname: entry.nickname,
 source: entry.source,
 disabled: entry.disabled,
 }
 if (!entry.disabled) {
 try {
 const account = await readPoolAccount(entry.uid)
 const balance = await fetchBalance(account)
 item.balance = balance
 if (!item.nickname && account.nickname) item.nickname = account.nickname
 } catch (error) {
 item.balanceError = errorMessage(error)
 }
 }
 enriched.push(item)
 }
 return NextResponse.json({ entries: enriched })
 } catch (error) {
 return jsonError(`读取号池失败：${errorMessage(error)}`)
 }
}

export async function POST(request: Request) {
 try {
 const body = await readJsonBody<{ credentials?: string }>(request)
 if (!body.credentials?.trim()) {
 return jsonError("缺少凭据内容",400)
 }
 const entry = await importPoolAccount(body.credentials.trim())
 return NextResponse.json({ ok: true, entry })
 } catch (error) {
 return jsonError(`导入失败：${errorMessage(error)}`,400)
 }
}
