"use client"

import { useEffect, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldCheck,
  Wrench,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  fetchCodexDesktopPluginStatus,
  repairCodexDesktopPlugins,
} from "@/lib/console-api"
import type { CodexDesktopPluginStatus } from "@/lib/codex-desktop-types"
import { toast } from "sonner"

function statusBadge(ok: boolean, okText = "正常", badText = "异常") {
  return (
    <Badge variant={ok ? "default" : "destructive"}>
      {ok ? okText : badText}
    </Badge>
  )
}

function PathLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
        {value || "未找到"}
      </code>
    </div>
  )
}

export function CodexPluginDoctorPanel() {
  const [status, setStatus] = useState<CodexDesktopPluginStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<"refresh" | "repair" | null>(null)
  const [error, setError] = useState("")

  async function refresh() {
    setWorking("refresh")
    try {
      setStatus(await fetchCodexDesktopPluginStatus())
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

  async function repair() {
    setWorking("repair")
    try {
      const result = await repairCodexDesktopPlugins()
      setStatus(result.status)
      setError("")
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setWorking(null)
    }
  }

  const busy = Boolean(working)

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {status?.healthy ? (
                <ShieldCheck className="size-4 text-emerald-600" />
              ) : (
                <Wrench className="size-4 text-muted-foreground" />
              )}
              插件修复
            </CardTitle>
            <CardDescription>
              检查并修复 Chrome、浏览器、电脑插件的 bundled marketplace 与 native host 路径
            </CardDescription>
          </div>
          {status ? statusBadge(status.healthy, "健康", "需要修复") : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            正在检查 Codex 桌面端插件状态
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
            <div className="grid gap-3 md:grid-cols-2">
              <PathLine label="Codex Home" value={status.codexHome} />
              <PathLine label="旧配置插件源" value={status.activeMarketplaceSource || "未配置"} />
              <PathLine label="本地插件缓存" value={status.stableMarketplacePath} />
              <PathLine label="最新 Codex 安装目录" value={status.latestInstallPath} />
            </div>

            <div className="grid gap-2 sm:grid-cols-5">
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">bundled 源</div>
                <div className="mt-2">
                  {statusBadge(!status.hasManualBundledMarketplace, "内置", "旧配置")}
                </div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">本地缓存</div>
                <div className="mt-2">
                  {statusBadge(status.stableMarketplaceExists, "存在", "缺失")}
                </div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">稳定源完整性</div>
                <div className="mt-2">
                  {statusBadge(status.stableMarketplaceComplete, "完整", "不完整")}
                </div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">Chrome host</div>
                <div className="mt-2">
                  {statusBadge(status.chromeNativeHostOk, "正常", "需修复")}
                </div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">Manifest</div>
                <div className="mt-2">
                  {statusBadge(status.chromeManifestOk, "正常", "异常")}
                </div>
              </div>
            </div>

            {status.issues.length > 0 ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2">
                <div className="mb-1 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="size-4" />
                  检测到的问题
                </div>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {status.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="size-4" />
                插件路径和 native host 当前正常
              </div>
            )}

            <div className="overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>插件</TableHead>
                    <TableHead>启用</TableHead>
                    <TableHead>源目录</TableHead>
                    <TableHead>文件完整</TableHead>
                    <TableHead>latest 缓存</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {status.plugins.map((plugin) => (
                    <TableRow key={plugin.id}>
                      <TableCell className="font-medium">{plugin.label}</TableCell>
                      <TableCell>{statusBadge(plugin.enabled, "已启用", "未启用")}</TableCell>
                      <TableCell>{statusBadge(plugin.sourceExists, "存在", "缺失")}</TableCell>
                      <TableCell>{statusBadge(plugin.requiredFilesOk, "完整", "不完整")}</TableCell>
                      <TableCell>{statusBadge(plugin.cacheLatestOk, "正常", "异常")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                修复会备份现有配置，复制官方 bundled 插件到稳定目录，并重建 Chrome native host 路径。
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
                  {working === "refresh" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RefreshCw data-icon="inline-start" />
                  )}
                  刷新
                </Button>
                <Button onClick={() => void repair()} disabled={busy}>
                  {working === "repair" ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Wrench data-icon="inline-start" />
                  )}
                  一键修复
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
