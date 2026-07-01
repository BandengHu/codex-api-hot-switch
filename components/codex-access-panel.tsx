"use client"

import { useEffect, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ListRestart,
  PlugZap,
  RefreshCw,
  RotateCcw,
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
import { Spinner } from "@/components/ui/spinner"
import { Separator } from "@/components/ui/separator"
import {
  fetchCodexConfigStatus,
  installCodexConfig,
  restoreCodexConfig,
  syncCodexModelCatalog,
} from "@/lib/console-api"
import type { CodexConfigStatus } from "@/lib/codex-config-types"
import { toast } from "sonner"
import { CodexConfigBackupManager } from "@/components/codex-config-backup-manager"

export function CodexAccessPanel() {
  const [status, setStatus] = useState<CodexConfigStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<
    "install" | "restore" | "refresh" | "sync-model-catalog" | null
  >(null)
  const [error, setError] = useState("")

  async function refresh() {
    setWorking("refresh")
    try {
      setStatus(await fetchCodexConfigStatus())
      setError("")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setWorking(null)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleInstall() {
    setWorking("install")
    try {
      const result = await installCodexConfig()
      setStatus(result.status)
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
    }
  }

  async function handleRestore() {
    setWorking("restore")
    try {
      const result = await restoreCodexConfig()
      setStatus(result.status)
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
    }
  }

  async function handleSyncModelCatalog() {
    setWorking("sync-model-catalog")
    try {
      const result = await syncCodexModelCatalog()
      setStatus(result.status)
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
    }
  }

  const busy = Boolean(working)
  const installed = status?.installed

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {installed ? (
                <CheckCircle2 className="size-4 text-chart-1" />
              ) : (
                <PlugZap className="size-4 text-muted-foreground" />
              )}
              Codex 模型接入
            </CardTitle>
            <CardDescription>把 Codex 桌面端模型下拉接到 SwitchGate 本地中转</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={installed ? "default" : "secondary"}>
              {installed ? "已接入" : "未接入"}
            </Badge>
            <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={busy}>
              {working === "refresh" ? (
                <Spinner className="size-4" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              <span className="sr-only">刷新</span>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-[1.15fr_0.85fr]">
          <Button
            className="h-auto justify-start gap-3 px-4 py-3 text-left"
            onClick={() => void handleInstall()}
            disabled={busy}
          >
            {working === "install" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlugZap data-icon="inline-start" />
            )}
            <span className="flex flex-col items-start gap-0.5">
              <span className="font-medium">一键设置本地中转模型</span>
              <span className="text-xs font-normal opacity-80">
                写入自动模型和模型目录，重启 Codex 后下拉生效
              </span>
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-auto justify-start gap-3 px-4 py-3 text-left"
            onClick={() => void handleRestore()}
            disabled={busy || !status?.backupExists}
          >
            {working === "restore" ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RotateCcw data-icon="inline-start" />
            )}
            <span className="flex flex-col items-start gap-0.5">
              <span className="font-medium">一键还原原 Codex 配置</span>
              <span className="text-xs font-normal text-muted-foreground">
                {status?.backupExists ? "恢复最新配置备份" : "暂无可恢复备份"}
              </span>
            </span>
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            正在读取 Codex 配置
          </div>
        ) : null}

        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {error}
          </div>
        ) : null}

        {status ? (
          <>
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">配置文件</span>
                <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {status.configPath}
                </code>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">目标地址</span>
                <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {status.targetBaseUrl}
                </code>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">当前 provider</span>
                <span className="font-mono text-xs">{status.currentProvider || "未设置"}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">当前 base_url</span>
                <span className="break-all font-mono text-xs">
                  {status.currentBaseUrl || "未设置"}
                </span>
              </div>
              <div className="flex flex-col gap-1 md:col-span-2">
                <span className="text-xs text-muted-foreground">模型目录</span>
                <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {status.currentModelCatalogPath || "未设置"}
                </code>
              </div>
            </div>
            <Separator />
            <CodexConfigBackupManager status={status} disabled={busy} onStatus={setStatus} />
            <Separator />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant={status.configExists ? "secondary" : "outline"}>
                  config {status.configExists ? "存在" : "未创建"}
                </Badge>
                <Badge variant={status.authReady ? "secondary" : "outline"}>
                  auth {status.authReady ? "可用" : "缺少 key"}
                </Badge>
                <Badge variant={status.backupExists ? "secondary" : "outline"}>
                  备份 {status.backupExists ? "可恢复" : "无"}
                </Badge>
                <Badge variant={status.modelCatalogExists ? "secondary" : "outline"}>
                  模型目录 {status.modelCatalogExists ? "已生成" : "未生成"}
                </Badge>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => void handleSyncModelCatalog()}
                  disabled={busy}
                >
                  {working === "sync-model-catalog" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <ListRestart data-icon="inline-start" />
                  )}
                  同步模型目录
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
