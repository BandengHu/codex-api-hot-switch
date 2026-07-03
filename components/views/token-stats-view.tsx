"use client"

import { useEffect, useMemo, useState } from "react"
import { BarChart3, Coins, RotateCcw, TrendingUp } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useConsole } from "@/lib/console-store"
import { resetTokenStats } from "@/lib/console-api"
import {
  formatTokenCount,
  sumTokenStats,
  tokenStatsSince,
} from "@/lib/token-stats"
import type { TokenStatEntry } from "@/lib/types"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

type RangeMode = "day" | "week" | "month"

interface ChartPoint {
  key: string
  label: string
  shortLabel: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
}

const RANGE_LABELS: Record<RangeMode, string> = {
  day: "日",
  week: "周",
  month: "月",
}

function startOfHour(date: Date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
  )
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addHours(date: Date, hours: number) {
  const next = new Date(date)
  next.setHours(next.getHours() + hours)
  return next
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function chartWindow(mode: RangeMode) {
  const now = new Date()
  if (mode === "day") {
    const end = startOfHour(now)
    const start = addHours(end, -23)
    return { start, end, count: 24, unit: "hour" as const }
  }
  if (mode === "week") {
    const end = startOfDay(now)
    const start = addDays(end, -6)
    return { start, end, count: 7, unit: "day" as const }
  }
  const end = startOfDay(now)
  const start = addDays(end, -29)
  return { start, end, count: 30, unit: "day" as const }
}

function makeBucket(date: Date, mode: RangeMode): ChartPoint {
  const label =
    mode === "day"
      ? date.toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          hour12: false,
        })
      : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })
  const shortLabel =
    mode === "day"
      ? `${String(date.getHours()).padStart(2, "0")}:00`
      : `${date.getMonth() + 1}/${date.getDate()}`
  return {
    key: date.toISOString(),
    label,
    shortLabel,
    timestamp: date.getTime(),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
  }
}

function bucketKey(timestamp: number, unit: "hour" | "day") {
  const date = new Date(timestamp)
  const bucket = unit === "hour" ? startOfHour(date) : startOfDay(date)
  return bucket.toISOString()
}

function buildChartPoints(entries: TokenStatEntry[], mode: RangeMode) {
  const { start, count, unit } = chartWindow(mode)
  const points = Array.from({ length: count }, (_, index) =>
    makeBucket(unit === "hour" ? addHours(start, index) : addDays(start, index), mode),
  )
  const byKey = new Map(points.map((point) => [point.key, point]))
  const startMs = points[0]?.timestamp ?? 0
  const endMs =
    (points[points.length - 1]?.timestamp ?? 0) +
    (unit === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000)

  for (const entry of entries) {
    const timestamp = Date.parse(entry.timestamp)
    if (!Number.isFinite(timestamp) || timestamp < startMs || timestamp >= endMs) {
      continue
    }
    const bucket = byKey.get(bucketKey(timestamp, unit))
    if (!bucket) continue
    bucket.inputTokens += entry.inputTokens
    bucket.outputTokens += entry.outputTokens
    bucket.totalTokens += entry.totalTokens
    bucket.requests += 1
  }

  return points
}

function chartX(index: number, pointCount: number, width: number) {
  return pointCount === 1 ? width / 2 : (index / (pointCount - 1)) * width
}

function linePath(points: ChartPoint[], width: number, height: number, maxValue: number) {
  if (points.length === 0) return ""
  return points
    .map((point, index) => {
      const x = chartX(index, points.length, width)
      const y = height - (point.totalTokens / maxValue) * height
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(" ")
}

function areaPath(points: ChartPoint[], width: number, height: number, maxValue: number) {
  const path = linePath(points, width, height, maxValue)
  if (!path) return ""
  return `${path} L ${width} ${height} L 0 ${height} Z`
}

function compactAxisNumber(value: number) {
  if (value >= 1000000) return `${Number((value / 1000000).toFixed(1))}M`
  if (value >= 1000) return `${Number((value / 1000).toFixed(1))}k`
  return String(Math.round(value))
}

function niceAxisMax(value: number) {
  if (value <= 0) return 100
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const nice =
    normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 5
          ? 5
          : 10
  return nice * magnitude
}

function xAxisIndexes(pointCount: number) {
  if (pointCount <= 1) return [0]
  if (pointCount <= 8) return Array.from({ length: pointCount }, (_, index) => index)
  const indexes = new Set<number>([0, pointCount - 1])
  const segments = 5
  for (let index = 1; index < segments; index += 1) {
    indexes.add(Math.round((index / segments) * (pointCount - 1)))
  }
  return Array.from(indexes).sort((a, b) => a - b)
}

function TokenLineChart({ points }: { points: ChartPoint[] }) {
  const plotWidth = 720
  const plotHeight = 250
  const leftAxisWidth = 76
  const rightPadding = 16
  const topPadding = 14
  const bottomAxisHeight = 38
  const chartWidth = leftAxisWidth + plotWidth + rightPadding
  const chartHeight = topPadding + plotHeight + bottomAxisHeight
  const hasData = points.some((point) => point.totalTokens > 0)
  const maxValue = niceAxisMax(Math.max(0, ...points.map((point) => point.totalTokens)))
  const yTicks = [1, 0.75, 0.5, 0.25, 0]
  const xTicks = xAxisIndexes(points.length)
  const peak = points.reduce(
    (current, point) => (point.totalTokens > current.totalTokens ? point : current),
    points[0] ?? {
      key: "",
      label: "",
      shortLabel: "",
      timestamp: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0,
    },
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="relative h-[360px] w-full overflow-hidden rounded-md border border-border bg-muted/25 p-4">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="h-full w-full"
          role="img"
          aria-label="token 消耗曲线"
        >
          <line
            x1={leftAxisWidth}
            x2={leftAxisWidth}
            y1={topPadding}
            y2={topPadding + plotHeight}
            className="stroke-border"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={leftAxisWidth}
            x2={leftAxisWidth + plotWidth}
            y1={topPadding + plotHeight}
            y2={topPadding + plotHeight}
            className="stroke-border"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          {yTicks.map((ratio) => {
            const y = topPadding + plotHeight - ratio * plotHeight
            const value = ratio * maxValue
            return (
              <g key={ratio}>
                <line
                  x1={leftAxisWidth}
                  x2={leftAxisWidth + plotWidth}
                  y1={y}
                  y2={y}
                  className="stroke-border"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={leftAxisWidth - 10}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-muted-foreground font-mono text-[11px]"
                >
                  {compactAxisNumber(value)}
                </text>
              </g>
            )
          })}
          {xTicks.map((index) => {
            const point = points[index]
            if (!point) return null
            const x = leftAxisWidth + chartX(index, points.length, plotWidth)
            return (
              <g key={point.key}>
                <line
                  x1={x}
                  x2={x}
                  y1={topPadding + plotHeight}
                  y2={topPadding + plotHeight + 5}
                  className="stroke-border"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={x}
                  y={topPadding + plotHeight + 22}
                  textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
                  className="fill-muted-foreground text-[11px]"
                >
                  {point.shortLabel}
                </text>
              </g>
            )
          })}
          <text
            x={leftAxisWidth}
            y={11}
            textAnchor="start"
            className="fill-muted-foreground text-[11px]"
          >
            tokens
          </text>
          <g transform={`translate(${leftAxisWidth} ${topPadding})`}>
            <path
              d={areaPath(points, plotWidth, plotHeight, maxValue)}
              className="fill-primary/10"
            />
            <path
              d={linePath(points, plotWidth, plotHeight, maxValue)}
              className="fill-none stroke-primary"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {points.map((point, index) => {
              const x = chartX(index, points.length, plotWidth)
              const y = plotHeight - (point.totalTokens / maxValue) * plotHeight
              return (
                <circle
                  key={point.key}
                  cx={x}
                  cy={y}
                  r={point.totalTokens > 0 ? 3.5 : 2}
                  className={cn(
                    point.totalTokens > 0 ? "fill-primary" : "fill-muted-foreground/30",
                  )}
                  vectorEffect="non-scaling-stroke"
                >
                  <title>
                    {point.label} · {formatTokenCount(point.totalTokens)} tokens
                  </title>
                </circle>
              )
            })}
          </g>
        </svg>
        {!hasData ? (
          <div className="pointer-events-none absolute inset-x-20 top-1/2 -translate-y-1/2 rounded-md border border-border bg-background/90 px-4 py-3 text-center shadow-sm">
            <div className="text-sm font-medium">这个时间范围还没有 token 记录</div>
            <div className="mt-1 text-xs text-muted-foreground">
              有请求完成并返回 usage 后会显示曲线。
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">峰值时间点</div>
          <div className="mt-1 text-sm font-medium">{peak.shortLabel}</div>
          <div className="font-mono text-xs text-muted-foreground">
            {formatTokenCount(peak.totalTokens)} tokens
          </div>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">最高输入</div>
          <div className="mt-1 font-mono text-sm font-medium">
            {formatTokenCount(Math.max(...points.map((point) => point.inputTokens)))}
          </div>
        </div>
        <div className="rounded-md border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">最高输出</div>
          <div className="mt-1 font-mono text-sm font-medium">
            {formatTokenCount(Math.max(...points.map((point) => point.outputTokens)))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function TokenStatsView() {
  const { tokenStats, settings, replaceSnapshot, refreshTokenStats } = useConsole()
  const [range, setRange] = useState<RangeMode>("day")
  useEffect(() => {
    void refreshTokenStats()
  }, [refreshTokenStats])

  const sinceReset = useMemo(
    () => tokenStatsSince(tokenStats, settings.tokenStatsResetAt),
    [settings.tokenStatsResetAt, tokenStats],
  )
  const totals = useMemo(() => sumTokenStats(sinceReset), [sinceReset])
  const chartPoints = useMemo(
    () => buildChartPoints(sinceReset, range),
    [range, sinceReset],
  )
  const rangeTotals = useMemo(
    () => ({
      inputTokens: chartPoints.reduce((sum, point) => sum + point.inputTokens, 0),
      outputTokens: chartPoints.reduce((sum, point) => sum + point.outputTokens, 0),
      totalTokens: chartPoints.reduce((sum, point) => sum + point.totalTokens, 0),
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      requests: chartPoints.reduce((sum, point) => sum + point.requests, 0),
    }),
    [chartPoints],
  )

  async function handleReset() {
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
          <h1 className="text-lg font-semibold">Token 统计</h1>
          <p className="text-sm text-muted-foreground">
            按时间查看中转层记录到的 token 消耗
          </p>
        </div>
        <Button variant="outline" onClick={() => void handleReset()}>
          <RotateCcw data-icon="inline-start" />
          清空累计
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="gap-0 py-0">
          <CardHeader className="flex flex-row items-center justify-between px-4 pt-4">
            <CardDescription className="text-xs">累计总 tokens</CardDescription>
            <Coins className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-1">
            <div className="font-mono text-2xl font-semibold tabular-nums">
              {formatTokenCount(totals.totalTokens)}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatTokenCount(totals.requests)} 次请求
            </p>
          </CardContent>
        </Card>
        <Card className="gap-0 py-0">
          <CardHeader className="flex flex-row items-center justify-between px-4 pt-4">
            <CardDescription className="text-xs">输入 tokens</CardDescription>
            <TrendingUp className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-1">
            <div className="font-mono text-2xl font-semibold tabular-nums">
              {formatTokenCount(totals.inputTokens)}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">累计口径</p>
          </CardContent>
        </Card>
        <Card className="gap-0 py-0">
          <CardHeader className="flex flex-row items-center justify-between px-4 pt-4">
            <CardDescription className="text-xs">输出 tokens</CardDescription>
            <BarChart3 className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-1">
            <div className="font-mono text-2xl font-semibold tabular-nums">
              {formatTokenCount(totals.outputTokens)}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">累计口径</p>
          </CardContent>
        </Card>
        <Card className="gap-0 py-0">
          <CardHeader className="flex flex-row items-center justify-between px-4 pt-4">
            <CardDescription className="text-xs">当前范围</CardDescription>
            <BarChart3 className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-1">
            <div className="font-mono text-2xl font-semibold tabular-nums">
              {formatTokenCount(rangeTotals.totalTokens)}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {RANGE_LABELS[range]}视图
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Token 消耗曲线</CardTitle>
              <CardDescription>
                {range === "day" ? "按小时聚合" : "按天聚合"}，显示每个时间点的总
                token 消耗
              </CardDescription>
            </div>
            <ToggleGroup
              value={[range]}
              onValueChange={(value) => {
                const next = value[0] as RangeMode | undefined
                if (next) setRange(next)
              }}
              size="sm"
              spacing={0}
            >
              <ToggleGroupItem value="day">日</ToggleGroupItem>
              <ToggleGroupItem value="week">周</ToggleGroupItem>
              <ToggleGroupItem value="month">月</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </CardHeader>
        <CardContent>
          <TokenLineChart points={chartPoints} />
        </CardContent>
      </Card>
    </div>
  )
}
