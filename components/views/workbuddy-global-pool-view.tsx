"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Globe2,
  Coins,
  ExternalLink,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  fetchGlobalPoolEntries,
  globalPoolAccountAction,
  importGlobalPoolAccount,
} from "@/lib/workbuddy-global-pool-api"
import type {
  WorkbuddyGlobalPoolEntryView,
  WorkbuddyGlobalRealm,
} from "@/lib/workbuddy-global-pool-types"
import { toast } from "sonner"
import { WorkbuddyGlobalPoolLoginDialog } from "./workbuddy-global-pool-login-dialog"

type BusyAction = "refresh" | "import" | { uid: string; action: string }

/**
 * WorkBuddy **国际版**号池页面。
 *
 * 与国内站号池页完全独立：独立账号列表、独立凭据目录、独立登录会话。
 * 这里只管理国际站（www.workbuddy.ai）账号，不涉及国内站的转发出口。
 */
export function WorkbuddyGlobalPoolView() {
  const [entries, setEntries] = useState<WorkbuddyGlobalPoolEntryView[]>([])
  const [realm, setRealm] = useState<WorkbuddyGlobalRealm | null>(null)
  const [busy, setBusy] = useState<BusyAction | null>("refresh")
  const [importOpen, setImportOpen] = useState(false)
  const [loginOpen, setLoginOpen] = useState(false)
  const [credentials, setCredentials] = useState("")

  const refresh = useCallback(async () => {
    setBusy("refresh")
    try {
      const snapshot = await fetchGlobalPoolEntries()
      setEntries(snapshot.entries)
      setRealm(snapshot.realm)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function handleImport() {
    setBusy("import")
    try {
      await importGlobalPoolAccount(credentials)
      toast.success("已导入国际版号池")
      setImportOpen(false)
      setCredentials("")
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  async function handleAccountAction(
    uid: string,
    action: "disable" | "enable" | "remove" | "balance" | "active",
  ) {
    setBusy({ uid, action })
    try {
      await globalPoolAccountAction(uid, action)
      if (action === "balance") toast.success("余额已刷新")
      else if (action === "active") toast.success("已设为国际版转发账号")
      else toast.success(action === "remove" ? "已移除" : action === "disable" ? "已禁用" : "已启用")
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const totalRemain = entries.reduce((sum, entry) => sum + (entry.balance?.remain ?? 0), 0)
  const availableCount = entries.filter((entry) => !entry.disabled).length

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Globe2 className="size-5" />
            WorkBuddy 国际版号池
          </h1>
          <p className="text-sm text-muted-foreground">
            管理 www.workbuddy.ai（国际站）账号；与国内站号池相互独立，互不影响
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void refresh()} disabled={busy !== null}>
            {busy === "refresh" ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
          <Button variant="outline" onClick={() => setLoginOpen(true)} disabled={busy !== null}>
            <ExternalLink className="size-4" />
            授权登录
          </Button>
          <Button onClick={() => setImportOpen(true)} disabled={busy !== null}>
            <Plus className="size-4" />
            导入账号
          </Button>
        </div>
      </div>

      <div className="flex gap-4">
        <Card className="flex-1">
          <CardHeader className="pb-2">
            <CardDescription>账号总数</CardDescription>
            <CardTitle className="text-2xl">{entries.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="flex-1">
          <CardHeader className="pb-2">
            <CardDescription>可用账号</CardDescription>
            <CardTitle className="text-2xl">{availableCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="flex-1">
          <CardHeader className="pb-2">
            <CardDescription>剩余额度合计</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Coins className="size-5 text-amber-500" />
              {totalRemain.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>国际版账号</CardTitle>
          <CardDescription>
            {realm
              ? `上游站点 ${realm.origin} · 设备流平台标识 ${realm.platform}`
              : "账号凭据保存在国际版号池目录，支持 refreshToken 自动续期"}
            <br />
            转发时使用「生效」账号的登录态；点「设为转发」可指定用哪个账号（不自动轮转）
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>昵称 / uid</TableHead>
                <TableHead>域</TableHead>
                <TableHead className="text-right">剩余额度</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.uid}>
                  <TableCell>
                    <div className="font-medium">{entry.nickname || "(未命名)"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{entry.uid}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{entry.domain || "—"}</TableCell>
                  <TableCell className="text-right font-mono">
                    {entry.balance ? entry.balance.remain.toLocaleString() : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      {entry.active ? <Badge>生效</Badge> : null}
                      {entry.disabled ? (
                        <Badge variant="outline">已禁用</Badge>
                      ) : entry.balanceError ? (
                        <Badge variant="destructive">凭据异常</Badge>
                      ) : (
                        <Badge variant="secondary">正常</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleAccountAction(entry.uid, "active")}
                        disabled={entry.disabled || entry.active || busy !== null}
                      >
                        {busy && typeof busy === "object" && busy.uid === entry.uid && busy.action === "active" ? (
                          <Spinner className="size-4" />
                        ) : (
                          <Zap className="size-4" />
                        )}
                        设为转发
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleAccountAction(entry.uid, "balance")}
                        disabled={entry.disabled || busy !== null}
                      >
                        {busy && typeof busy === "object" && busy.uid === entry.uid && busy.action === "balance" ? (
                          <Spinner className="size-4" />
                        ) : (
                          <RefreshCw className="size-4" />
                        )}
                        余额
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void handleAccountAction(entry.uid, entry.disabled ? "enable" : "disable")
                        }
                        disabled={busy !== null}
                      >
                        <Power className="size-4" />
                        {entry.disabled ? "启用" : "禁用"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleAccountAction(entry.uid, "remove")}
                        disabled={busy !== null}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!entries.length && !busy ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    国际版号池为空，点右上角「授权登录」或「导入账号」添加
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>导入国际版账号</DialogTitle>
            <DialogDescription>
              粘贴国际版凭据 JSON（与 workbuddy-desktop.info 同格式），也可直接粘贴
              WorkBuddy2API 写出的 ~/.workbuddy2api-auth.json 内容
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder='{"auth": {...}, "account": {...}}'
            value={credentials}
            onChange={(event) => setCredentials(event.target.value)}
            className="min-h-40 font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)} disabled={busy === "import"}>
              取消
            </Button>
            <Button onClick={() => void handleImport()} disabled={busy === "import" || !credentials.trim()}>
              {busy === "import" ? <Spinner className="size-4" /> : null}
              导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <WorkbuddyGlobalPoolLoginDialog
        open={loginOpen}
        onOpenChange={setLoginOpen}
        onLoggedIn={(message) => {
          toast.success(message)
          void refresh()
        }}
      />
    </div>
  )
}
