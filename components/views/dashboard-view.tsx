"use client"

import { useEffect, useState } from "react"
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Timer,
  XCircle,
  Power,
  PlayCircle,
  PauseCircle,
  FlaskConical,
  Coins,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { Separator } from "@/components/ui/separator"
import { StatCard } from "@/components/stat-card"
import { HotSwitchPanel } from "@/components/hot-switch-panel"
import {
  HealthBadge,
  ProtocolBadge,
  ReasoningBadge,
} from "@/components/status-badges"
import { useConsole } from "@/lib/console-store"
import { resetTokenStats, testProvider } from "@/lib/console-api"
import {
  formatDurationSeconds,
  formatIntegerCount,
  formatTokenCount,
} from "@/lib/display-format"
import { REASONING_LABELS } from "@/lib/types"
import {
  sumTokenStats,
  tokenStatsSince,
} from "@/lib/token-stats"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

const RECENT_WINDOW_MS = 15 * 60 * 1000

export function DashboardView() {
  const {
    runtime,
    getProvider,
    getModel,
    settings,
    logs,
    tokenStats,
    setTakeover,
    updateProvider,
    replaceSnapshot,
    refreshTelemetry,
    loading,
    error,
  } =
    useConsole()
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void refreshTelemetry()
  }, [refreshTelemetry])

  const provider = getProvider(runtime.activeProviderId)
  const model = getModel(runtime.activeModelId)
  const isActive = runtime.takeover === "active"
  const endpoint = `http://${settings.listenAddress}:${settings.port}/v1`

  const recentLogs = logs.filter((log) => {
    const timestamp = Date.parse(log.timestamp)
    return Number.isFinite(timestamp) && Date.now() - timestamp <= RECENT_WINDOW_MS
  })
  const total = recentLogs.length
  const success = recentLogs.filter((l) => l.statusCode >= 200 && l.statusCode < 300).length
  const errors = total - success
  const successRate = total ? Math.round((success / total) * 100) : 0
  const avgLatency = total
    ? recentLogs.reduce((s, l) => s + l.durationMs, 0) / total
    : 0
  const cumulativeTokenStats = tokenStatsSince(
    tokenStats,
    settings.tokenStatsResetAt,
  )
  const cumulativeTokens = sumTokenStats(cumulativeTokenStats)
  const resetTime = new Date(settings.tokenStatsResetAt)
  const resetLabel = Number.isFinite(resetTime.getTime())
    ? resetTime.toLocaleString("zh-CN", { hour12: false })
    : "未重置"

  async function handleTest() {
    if (!provider) {
      toast.error("测试失败：当前没有生效供应商")
      return
    }
    setTesting(true)
    try {
      const result = await testProvider(provider)
      if (result.provider) updateProvider(result.provider)
      if (result.ok) {
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }

  async function handleResetTokens() {
    try {
      const snapshot = await resetTokenStats()
      replaceSnapshot(snapshot)
      toast.success("Token 累计已重新开始")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">总览</h1>
          <p className="text-sm text-muted-foreground">
            本地中转层运行状态与当前生效策略
          </p>
        </div>
        <Button
          variant={isActive ? "outline" : "default"}
          onClick={() => {
            setTakeover(isActive ? "paused" : "active")
            toast.success(isActive ? "已暂停接管" : "已启用接管")
          }}
        >
          {isActive ? (
            <PauseCircle data-icon="inline-start" />
          ) : (
            <PlayCircle data-icon="inline-start" />
          )}
          {isActive ? "暂停接管" : "启用接管"}
        </Button>
      </div>

      {loading ? (
        <Alert>
          <Activity />
          <AlertTitle>正在读取本地配置</AlertTitle>
          <AlertDescription>首次启动会创建 .data/hot-switch-state.json。</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>控制台状态异常</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {/* 当前生效配置 */}
      <Card
        className={cn(
          isActive
            ? "bg-emerald-50/40 ring-emerald-500/25 dark:bg-emerald-950/10 dark:ring-emerald-500/30"
            : undefined,
        )}
      >
        <CardHeader>
          <div className="flex items-center gap-2">
            <Power
              className={isActive ? "size-4 text-emerald-600" : "size-4 text-muted-foreground"}
            />
            <CardTitle
              className={cn("text-base", isActive ? "text-emerald-700" : undefined)}
            >
              {isActive ? "接管已启用" : "接管已暂停"}
            </CardTitle>
          </div>
          <CardDescription>
            所有 Codex 请求按以下配置在本地中转层重写并转发
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">生效供应商</span>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{provider?.name ?? "—"}</span>
              {provider ? <HealthBadge status={provider.health} /> : null}
            </div>
            {provider ? <ProtocolBadge protocol={provider.protocol} /> : null}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">生效模型</span>
            <span className="text-sm font-medium">{model?.displayName ?? "—"}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {model?.modelId ?? "—"}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">推理强度</span>
            <div>
              <ReasoningBadge effort={runtime.reasoning} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">本地中转地址</span>
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs">
              {endpoint}
            </code>
          </div>
        </CardContent>
      </Card>

      {/* 指标 */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="最近请求数" value={String(total)} hint="最近 15 分钟" icon={Activity} />
        <StatCard
          label="成功率"
          value={`${successRate}%`}
          hint={`${success} / ${total} 成功`}
          icon={CheckCircle2}
          tone={successRate >= 90 ? "good" : successRate >= 70 ? "warn" : "bad"}
        />
        <StatCard
          label="平均延迟"
          value={formatDurationSeconds(avgLatency)}
          hint="端到端往返"
          icon={Timer}
        />
        <StatCard
          label="错误数"
          value={String(errors)}
          hint="非 2xx 响应"
          icon={XCircle}
          tone={errors > 0 ? "bad" : "good"}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Coins className="size-4 text-muted-foreground" />
                <CardTitle className="text-base">累计 Token</CardTitle>
              </div>
              <CardDescription>
                从 {resetLabel} 起累计，清空后从当前时间重新统计
              </CardDescription>
            </div>
            <Button variant="outline" onClick={() => void handleResetTokens()}>
              <RotateCcw data-icon="inline-start" />
              清空累计
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2">
            <div className="text-xs text-muted-foreground">总 tokens</div>
            <div className="mt-1 font-mono text-3xl font-semibold tabular-nums">
              {formatTokenCount(cumulativeTokens.totalTokens)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatIntegerCount(cumulativeTokens.requests)} 次有 token 记录的请求
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">输入</div>
            <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
              {formatTokenCount(cumulativeTokens.inputTokens)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">输出</div>
            <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
              {formatTokenCount(cumulativeTokens.outputTokens)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">缓存命中</div>
            <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
              {formatTokenCount(cumulativeTokens.cachedInputTokens)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">推理</div>
            <div className="mt-1 font-mono text-lg font-semibold tabular-nums">
              {formatTokenCount(cumulativeTokens.reasoningTokens)}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 热切换面板 */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">热切换面板</CardTitle>
              <CardDescription>
                快速切换供应商、模型与推理强度，应用后立即生效
              </CardDescription>
            </div>
            <Button variant="secondary" onClick={handleTest} disabled={testing}>
              {testing ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FlaskConical data-icon="inline-start" />
              )}
              测试当前配置
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6">
          <HotSwitchPanel compact />
        </CardContent>
      </Card>
    </div>
  )
}
