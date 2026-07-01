"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { StatusCodeBadge, ReasoningBadge } from "@/components/status-badges"
import { useConsole } from "@/lib/console-store"
import type { RequestLog } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useResizableSheetWidth } from "@/components/views/use-resizable-sheet-width"

const LOG_DETAIL_WIDTH_KEY = "codex-hot-switch-log-detail-width"
const DETAIL_MIN_WIDTH = 480
const DETAIL_MAX_WIDTH = 1120
const DETAIL_DEFAULT_WIDTH = 720

function fmtTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleTimeString("zh-CN", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0")
}

function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
      {text}
    </pre>
  )
}

function formatTokenCount(value: number | undefined) {
  if (value == null) return "—"
  return new Intl.NumberFormat("zh-CN").format(value)
}

function tokenSummary(log: RequestLog) {
  const usage = log.tokenUsage
  if (!usage) return "—"
  if (usage.totalTokens != null) return formatTokenCount(usage.totalTokens)
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  if (input || output) return formatTokenCount(input + output)
  return "—"
}

function TokenMetric({
  label,
  value,
  className,
}: {
  label: string
  value: number | undefined
  className?: string
}) {
  return (
    <div className={cn("rounded-md border border-border px-3 py-2", className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm tabular-nums">
        {formatTokenCount(value)}
      </div>
    </div>
  )
}

export function LogsView() {
  const { logs, providers, refresh, loading } = useConsole()
  const [statusFilter, setStatusFilter] = useState("all")
  const [providerFilter, setProviderFilter] = useState("all")
  const [modelFilter, setModelFilter] = useState("all")
  const [selected, setSelected] = useState<RequestLog | null>(null)
  const {
    isResizing,
    sheetStyle,
    handleProps: detailResizeHandleProps,
  } = useResizableSheetWidth({
    storageKey: LOG_DETAIL_WIDTH_KEY,
    minWidth: DETAIL_MIN_WIDTH,
    maxWidth: DETAIL_MAX_WIDTH,
    defaultWidth: DETAIL_DEFAULT_WIDTH,
  })

  const filtered = useMemo(() => {
    return logs.filter((l) => {
      if (statusFilter === "success" && !(l.statusCode >= 200 && l.statusCode < 300))
        return false
      if (statusFilter === "error" && l.statusCode >= 200 && l.statusCode < 300)
        return false
      if (providerFilter !== "all" && l.finalProviderId !== providerFilter)
        return false
      if (modelFilter !== "all" && l.finalModelId !== modelFilter) return false
      return true
    })
  }, [logs, statusFilter, providerFilter, modelFilter])

  const uniqueFinalModels = Array.from(new Set(logs.map((l) => l.finalModelId)))

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">请求日志</h1>
            <p className="text-sm text-muted-foreground">
              中转层处理的最近请求，错误信息直接暴露真实原因
            </p>
          </div>
          <Button variant="outline" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw
              data-icon="inline-start"
              className={loading ? "animate-spin" : undefined}
            />
            刷新
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle className="text-base">最近请求</CardTitle>
              <CardDescription>
                共 {logs.length} 条 · 当前显示 {filtered.length} 条
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">状态</Label>
                <Select
                  value={statusFilter}
                  onValueChange={(value) => value && setStatusFilter(value)}
                >
                  <SelectTrigger size="sm" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">全部</SelectItem>
                      <SelectItem value="success">成功</SelectItem>
                      <SelectItem value="error">错误</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">供应商</Label>
                <Select
                  value={providerFilter}
                  onValueChange={(value) => value && setProviderFilter(value)}
                >
                  <SelectTrigger size="sm" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">全部</SelectItem>
                      {providers.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">模型</Label>
                <Select
                  value={modelFilter}
                  onValueChange={(value) => value && setModelFilter(value)}
                >
                  <SelectTrigger size="sm" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">全部</SelectItem>
                      {uniqueFinalModels.map((mid) => (
                        <SelectItem key={mid} value={mid}>
                          {mid}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {filtered.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>没有匹配的日志</EmptyTitle>
                <EmptyDescription>调整筛选条件后再试。</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>Codex 原始模型</TableHead>
                  <TableHead>最终供应商 / 模型</TableHead>
                  <TableHead>reasoning</TableHead>
                  <TableHead className="text-right">tokens</TableHead>
                  <TableHead className="text-center">状态码</TableHead>
                  <TableHead className="text-right">耗时</TableHead>
                  <TableHead>错误信息</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((l) => {
                  const provider = providers.find((p) => p.id === l.finalProviderId)
                  return (
                    <TableRow
                      key={l.id}
                      className="cursor-pointer"
                      onClick={() => setSelected(l)}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {fmtTime(l.timestamp)}
                      </TableCell>
                      <TableCell>
                        <code className="font-mono text-xs">{l.codexModel}</code>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-xs text-muted-foreground">
                            {provider?.name ?? l.finalProviderId}
                          </span>
                          <code className="font-mono text-xs">{l.finalModelId}</code>
                        </div>
                      </TableCell>
                      <TableCell>
                        <ReasoningBadge effort={l.reasoning} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {tokenSummary(l)}
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusCodeBadge code={l.statusCode} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">
                        {l.durationMs}ms
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        {l.error ? (
                          <span className="block truncate text-xs text-destructive">
                            {l.error}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!selected} onOpenChange={(v) => !v && setSelected(null)}>
        <SheetContent
          className={cn(
            "flex max-w-none flex-col gap-0 sm:max-w-none",
            isResizing && "transition-none",
          )}
          style={sheetStyle}
        >
          <div
            {...detailResizeHandleProps}
            className={cn(
              "absolute inset-y-0 left-0 z-20 w-4 -translate-x-1/2 cursor-ew-resize touch-none bg-transparent transition hover:bg-primary/15",
              isResizing && "bg-primary/20",
            )}
          />
          <SheetHeader>
            <SheetTitle>请求详情</SheetTitle>
            <SheetDescription>
              {selected ? fmtTime(selected.timestamp) : ""} · {selected?.codexModel}
            </SheetDescription>
          </SheetHeader>
          {selected ? (
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusCodeBadge code={selected.statusCode} />
                <ReasoningBadge effort={selected.reasoning} />
                <span className="font-mono text-xs text-muted-foreground">
                  {selected.durationMs}ms
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                <TokenMetric label="输入 tokens" value={selected.tokenUsage?.inputTokens} />
                <TokenMetric label="输出 tokens" value={selected.tokenUsage?.outputTokens} />
                <TokenMetric label="总 tokens" value={selected.tokenUsage?.totalTokens} />
                <TokenMetric
                  label="缓存命中"
                  value={selected.tokenUsage?.cachedInputTokens}
                  className="md:col-span-1"
                />
                <TokenMetric
                  label="缓存写入"
                  value={selected.tokenUsage?.cacheCreationInputTokens}
                  className="md:col-span-1"
                />
                <TokenMetric
                  label="推理 tokens"
                  value={selected.tokenUsage?.reasoningTokens}
                  className="md:col-span-1"
                />
              </div>

              {selected.error ? (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertTitle>请求失败</AlertTitle>
                  <AlertDescription>{selected.error}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <h3 className="text-sm font-medium">原始请求摘要</h3>
                <CodeBlock text={selected.rawRequest} />
              </div>

              <Separator />

              <div className="flex flex-col gap-1.5">
                <h3 className="text-sm font-medium">重写后的请求摘要</h3>
                <CodeBlock text={selected.rewrittenRequest} />
              </div>

              <Separator />

              <div className="flex flex-col gap-1.5">
                <h3 className="text-sm font-medium">响应摘要</h3>
                <CodeBlock text={selected.responseSummary} />
              </div>

              {selected.errorStack ? (
                <>
                  <Separator />
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-sm font-medium text-destructive">错误堆栈</h3>
                    <CodeBlock text={selected.errorStack} />
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
