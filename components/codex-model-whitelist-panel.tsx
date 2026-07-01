"use client"

import { useEffect, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ListChecks,
  Play,
  RotateCcw,
  RefreshCw,
  WandSparkles,
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
  fetchCodexDesktopModelWhitelistStatus,
  injectCodexDesktopModelWhitelist,
  launchCodexDesktopWithModelWhitelist,
  restartCodexDesktopWithModelWhitelist,
} from "@/lib/console-api"
import type { CodexDesktopModelWhitelistStatus } from "@/lib/codex-desktop-model-whitelist-types"
import { toast } from "sonner"

function statusBadge(ok: boolean, okText = "正常", badText = "异常") {
  return <Badge variant={ok ? "default" : "destructive"}>{ok ? okText : badText}</Badge>
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

export function CodexModelWhitelistPanel() {
  const [status, setStatus] = useState<CodexDesktopModelWhitelistStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState<"refresh" | "inject" | "launch" | "restart" | null>(null)
  const [error, setError] = useState("")

  async function refresh() {
    setWorking("refresh")
    try {
      setStatus(await fetchCodexDesktopModelWhitelistStatus())
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

  async function handleInject() {
    setWorking("inject")
    try {
      const result = await injectCodexDesktopModelWhitelist()
      setStatus(result.status)
      setError("")
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
      setLoading(false)
    }
  }

  async function handleLaunch() {
    setWorking("launch")
    try {
      const result = await launchCodexDesktopWithModelWhitelist()
      setStatus(result.status)
      setError("")
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
      setLoading(false)
    }
  }

  async function handleRestart() {
    setWorking("restart")
    try {
      const result = await restartCodexDesktopWithModelWhitelist()
      setStatus(result.status)
      setError("")
      toast.success(result.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
      setLoading(false)
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
                <CheckCircle2 className="size-4 text-emerald-600" />
              ) : (
                <ListChecks className="size-4 text-muted-foreground" />
              )}
              模型白名单解锁
            </CardTitle>
            <CardDescription>
              对齐 Codex++：把 SwitchGate 的 /v1/models 注入 Codex 桌面端模型下拉
            </CardDescription>
          </div>
          {status ? statusBadge(status.healthy, "已注入", "未就绪") : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            正在检查 Codex 模型白名单状态
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
              <PathLine label="Codex 可执行文件" value={status.codexExePath} />
              <PathLine label="本地模型接口" value={`${status.relayBaseUrl}/v1/models`} />
              <PathLine label="当前 CDP 页面" value={status.targetTitle || status.targetUrl} />
              <PathLine label="Codex 安装目录" value={status.codexInstallPath} />
            </div>

            <div className="grid gap-2 sm:grid-cols-5">
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">CDP {status.debugPort}</div>
                <div className="mt-2">{statusBadge(status.cdpReachable, "可连接", "不可连接")}</div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">Codex 页面</div>
                <div className="mt-2">{statusBadge(status.targetFound, "已找到", "未找到")}</div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">注入状态</div>
                <div className="mt-2">{statusBadge(status.injected, "已注入", "未注入")}</div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">模型接口</div>
                <div className="mt-2">{statusBadge(status.modelSourceOk, "可用", "异常")}</div>
              </div>
              <div className="rounded-md border px-3 py-2">
                <div className="text-xs text-muted-foreground">模型数</div>
                <div className="mt-2 text-sm font-medium">{status.modelCount}</div>
              </div>
            </div>

            {!status.cdpReachable && status.cdpError ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4" />
                {status.codexRunningWithoutCdp
                  ? "当前 Codex 已经运行，但不是从 SwitchGate 白名单启动，调试端口没有打开。请正常关闭后用白名单启动。"
                  : "当前 Codex 没有开放调试端口。请用“启动带模型白名单的 Codex”打开桌面端。"}
              </div>
            ) : null}

            {status.modelPreview.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {status.modelPreview.map((model) => (
                  <Badge key={model} variant="secondary" className="max-w-full truncate">
                    {model}
                  </Badge>
                ))}
              </div>
            ) : null}

            {status.injectionInfo?.failures?.length ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                最近注入异常：{status.injectionInfo.failures.join("；")}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                已打开的 Codex 若不是带 CDP 启动，只能检测到不可连接；以后从这里启动即可自动注入。
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
                  {working === "refresh" ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
                  刷新
                </Button>
                <Button variant="outline" onClick={() => void handleInject()} disabled={busy || !status.cdpReachable}>
                  {working === "inject" ? <Spinner data-icon="inline-start" /> : <WandSparkles data-icon="inline-start" />}
                  注入当前 Codex
                </Button>
                <Button onClick={() => void handleLaunch()} disabled={busy || !status.codexExeExists}>
                  {working === "launch" ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                  启动带模型白名单的 Codex
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => void handleRestart()}
                  disabled={busy || !status.codexExeExists}
                >
                  {working === "restart" ? <Spinner data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" />}
                  正常关闭并重启注入
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
