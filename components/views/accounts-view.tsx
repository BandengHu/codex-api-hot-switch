"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, Copy, RefreshCw, Shield, UserCheck, UserX } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"

interface AccountRow {
  id: string
  username: string
  role: "admin" | "member"
  status: "pending" | "active" | "disabled"
  createdAt: string
  approvedAt?: string
}

const STATUS_LABEL: Record<AccountRow["status"], string> = {
  pending: "待审批",
  active: "已启用",
  disabled: "已停用",
}

async function readError(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string | { message?: string }; message?: string }
    | null
  return (
    (typeof payload?.error === "string" ? payload.error : payload?.error?.message) ||
    payload?.message ||
    `${response.status} ${response.statusText}`
  )
}

export function AccountsView() {
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState("")
  const [issuedKey, setIssuedKey] = useState<{ username: string; apiKey: string } | null>(
    null,
  )
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/admin/accounts", { cache: "no-store" })
      if (!response.ok) throw new Error(await readError(response))
      const payload = (await response.json()) as { accounts: AccountRow[] }
      setAccounts(payload.accounts)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function changeStatus(account: AccountRow, status: AccountRow["status"]) {
    setBusyId(account.id)
    try {
      const response = await fetch(`/api/admin/accounts/${account.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      })
      if (!response.ok) throw new Error(await readError(response))
      const payload = (await response.json()) as { apiKey?: string }
      if (payload.apiKey) {
        setIssuedKey({ username: account.username, apiKey: payload.apiKey })
        setCopied(false)
      }
      toast.success(status === "active" ? "已通过审批" : "已更新账号状态")
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId("")
    }
  }

  const pendingCount = accounts.filter((account) => account.status === "pending").length

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Shield className="size-4" />
              账号审批
            </CardTitle>
            <CardDescription>
              新注册账号默认待审批；审批通过时会生成该账号自己的空白配置与独立 API Key。
              {pendingCount > 0 ? ` 当前有 ${pendingCount} 个账号等待处理。` : ""}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw data-icon="inline-start" />
            刷新
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {issuedKey ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
              <div className="text-sm font-medium">
                {issuedKey.username} 的 API Key（只显示这一次）
              </div>
              <div className="flex gap-2">
                <Input readOnly value={issuedKey.apiKey} className="font-mono" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    void navigator.clipboard.writeText(issuedKey.apiKey)
                    setCopied(true)
                    toast.success("已复制")
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  <span className="sr-only">复制 API Key</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                现在把它发给该账号的用户；对方登录后也可以在设置页自行更换。
              </p>
            </div>
          ) : null}

          {loading ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有账号。</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 pr-3 font-medium">用户名</th>
                    <th className="py-2 pr-3 font-medium">角色</th>
                    <th className="py-2 pr-3 font-medium">状态</th>
                    <th className="py-2 pr-3 font-medium">注册时间</th>
                    <th className="py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => (
                    <tr key={account.id} className="border-b border-border/60">
                      <td className="py-2 pr-3 font-medium">{account.username}</td>
                      <td className="py-2 pr-3">
                        {account.role === "admin" ? "管理员" : "普通"}
                      </td>
                      <td className="py-2 pr-3">{STATUS_LABEL[account.status]}</td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {new Date(account.createdAt).toLocaleString("zh-CN")}
                      </td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          {account.status !== "active" ? (
                            <Button
                              size="sm"
                              disabled={busyId === account.id}
                              onClick={() => void changeStatus(account, "active")}
                            >
                              <UserCheck data-icon="inline-start" />
                              通过
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyId === account.id}
                              onClick={() => void changeStatus(account, "disabled")}
                            >
                              <UserX data-icon="inline-start" />
                              停用
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
