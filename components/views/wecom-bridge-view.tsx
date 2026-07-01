"use client"

import { useEffect, useState } from "react"
import {
  Bot,
  CheckCircle2,
  Copy,
  FolderOpen,
  KeyRound,
  MessageSquareText,
  Play,
  RefreshCw,
  Save,
  Square,
  TerminalSquare,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import {
  fetchWecomBridgeStatus,
  saveWecomBridgeSettings,
  startWecomBridgeServe,
  stopWecomBridgeServe,
} from "@/lib/console-api"
import type {
  WecomBridgeDiagnosticState,
  WecomBridgeProcessState,
  WecomBridgeSettings,
  WecomBridgeStatus,
} from "@/lib/wecom-bridge-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

const STATE_LABELS: Record<WecomBridgeProcessState, string> = {
  idle: "未启动",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  exited: "已退出",
  failed: "异常",
  "external-running": "外部运行中",
}

function statusVariant(state: WecomBridgeProcessState) {
  if (state === "running" || state === "external-running") return "secondary"
  if (state === "failed") return "destructive"
  if (state === "starting" || state === "stopping") return "default"
  return "outline"
}

function diagnosticVariant(state: WecomBridgeDiagnosticState) {
  if (state === "ok") return "secondary"
  if (state === "error") return "destructive"
  return "outline"
}

function formatTime(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)
}

function mergeLogs(...items: string[]) {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

function ProcessBadge({
  state,
  owned,
}: {
  state: WecomBridgeProcessState
  owned?: boolean
}) {
  return (
    <Badge variant={statusVariant(state)}>
      {STATE_LABELS[state]}
      {owned ? " · SwitchGate" : ""}
    </Badge>
  )
}

function DiagnosticBadge({ state }: { state: WecomBridgeDiagnosticState }) {
  const label = state === "ok" ? "正常" : state === "error" ? "错误" : "提醒"
  return <Badge variant={diagnosticVariant(state)}>{label}</Badge>
}

function PathLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 truncate text-right text-xs">{value || "-"}</code>
    </div>
  )
}

function useWecomBridge() {
  const [status, setStatus] = useState<WecomBridgeStatus | null>(null)
  const [draft, setDraft] = useState<WecomBridgeSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const next = await fetchWecomBridgeStatus()
      setStatus(next)
      setDraft((current) => current ?? next.settings)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function run(task: () => Promise<{ message: string; status: WecomBridgeStatus }>) {
    setWorking(true)
    setError(null)
    try {
      const result = await task()
      setStatus(result.status)
      setDraft(result.status.settings)
      toast.success(result.message)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast.error(message)
    } finally {
      setWorking(false)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => {
      void fetchWecomBridgeStatus()
        .then((next) => {
          setStatus(next)
          setDraft((current) => current ?? next.settings)
        })
        .catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  return { status, draft, setDraft, loading, working, error, refresh, run }
}

export function WecomBridgeView() {
  const { status, draft, setDraft, loading, working, error, refresh, run } =
    useWecomBridge()
  const logs = mergeLogs(status?.logs.serveErr || "", status?.logs.serveOut || "")
  const canStart = Boolean(draft?.botId.trim() && draft?.secret.trim())

  function updateDraft(patch: Partial<WecomBridgeSettings>) {
    setDraft((current) => (current ? { ...current, ...patch } : current))
  }

  async function copyText(value: string, label: string) {
    await navigator.clipboard.writeText(value)
    toast.success(`${label} 已复制`)
  }

  function saveSettings() {
    if (!draft) return
    void run(() => saveWecomBridgeSettings(draft))
  }

  function toggleEnabled(enabled: boolean) {
    if (!draft) return
    if (enabled) {
      if (!canStart) {
        toast.error("请先填写 Bot ID 和 Secret")
        return
      }
      void run(async () => {
        await saveWecomBridgeSettings({ ...draft, enabled: true })
        return startWecomBridgeServe()
      })
      return
    }
    void run(stopWecomBridgeServe)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">企业微信机器人</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            使用企业微信应用机器人长连接接入，消息继续复用 CodexBridge 的命令和会话控制能力。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void refresh()} disabled={loading || working}>
            <RefreshCw className={cn("size-4", loading ? "animate-spin" : "")} />
            刷新
          </Button>
          <Button onClick={saveSettings} disabled={!draft || working}>
            <Save className="size-4" />
            保存设置
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-destructive">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>连接状态</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="size-4" />
              <ProcessBadge state={status?.serve.state || "idle"} owned={status?.serve.owned} />
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Bot ID</CardDescription>
            <CardTitle className="truncate text-base">{status?.settings.botId || "未配置"}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>默认工作目录</CardDescription>
            <CardTitle className="truncate text-base">{status?.settings.cwd || "-"}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>最后退出</CardDescription>
            <CardTitle className="text-base">{formatTime(status?.serve.exitedAt)}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" />
              接入配置
            </CardTitle>
            <CardDescription>Bot ID 和 Secret 来自企业微信应用机器人；Secret 保存后界面只显示掩码。</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-muted/30 px-3 py-3">
                <div className="min-w-0">
                  <FieldLabel>启用企业微信机器人</FieldLabel>
                  <FieldDescription>开启后会启动长连接服务；关闭会停止服务。</FieldDescription>
                </div>
                <Switch
                  checked={status?.serve.state === "running" || status?.serve.state === "external-running"}
                  disabled={working || loading}
                  onCheckedChange={toggleEnabled}
                />
              </div>

              <Field>
                <FieldLabel>Bot ID</FieldLabel>
                <Input
                  value={draft?.botId || ""}
                  placeholder="填写企业微信应用机器人的 Bot ID / Agent ID"
                  onChange={(event) => updateDraft({ botId: event.target.value })}
                />
              </Field>

              <Field>
                <FieldLabel>Secret</FieldLabel>
                <Input
                  type="password"
                  value={draft?.secret || ""}
                  placeholder="填写企业微信应用机器人的 Secret"
                  onChange={(event) => updateDraft({ secret: event.target.value })}
                />
              </Field>

              <Field>
                <FieldLabel>Corp ID（可选）</FieldLabel>
                <Input
                  value={draft?.corpId || ""}
                  placeholder="可选，用于日志和上下文标识"
                  onChange={(event) => updateDraft({ corpId: event.target.value })}
                />
              </Field>

              <Field>
                <FieldLabel>默认工作目录</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    value={draft?.cwd || ""}
                    placeholder="企业微信新建会话默认工作目录"
                    onChange={(event) => updateDraft({ cwd: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => draft?.cwd && void copyText(draft.cwd, "默认工作目录")}
                  >
                    <FolderOpen className="size-4" />
                  </Button>
                </div>
              </Field>

              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel>单条消息长度</FieldLabel>
                  <Input
                    type="number"
                    min={200}
                    value={draft?.maxMessageLength || 4000}
                    onChange={(event) =>
                      updateDraft({ maxMessageLength: Number(event.target.value) || 4000 })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>语言</FieldLabel>
                  <Select
                    value={draft?.locale || "auto"}
                    onValueChange={(value) =>
                      updateDraft({ locale: value as WecomBridgeSettings["locale"] })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="auto">自动</SelectItem>
                        <SelectItem value="zh-CN">中文</SelectItem>
                        <SelectItem value="en">English</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </div>

              <Field>
                <FieldLabel>Codex 可执行文件</FieldLabel>
                <Input
                  value={draft?.codexRealBin || ""}
                  placeholder="留空使用 PATH 中的 codex"
                  onChange={(event) => updateDraft({ codexRealBin: event.target.value })}
                />
              </Field>

              <Field>
                <FieldLabel>Provider Profile</FieldLabel>
                <Input
                  value={draft?.providerProfileId || ""}
                  placeholder="留空使用 CodexBridge 默认 profile"
                  onChange={(event) => updateDraft({ providerProfileId: event.target.value })}
                />
              </Field>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-3">
                  <div>
                    <FieldLabel>启用 Codex Native API</FieldLabel>
                    <FieldDescription>保留 CodexBridge 原有 Native API 能力。</FieldDescription>
                  </div>
                  <Switch
                    checked={draft?.nativeApiEnabled ?? true}
                    onCheckedChange={(value) => updateDraft({ nativeApiEnabled: value })}
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-3">
                  <div>
                    <FieldLabel>调试日志</FieldLabel>
                    <FieldDescription>输出更多企业微信 SDK 和运行时日志。</FieldDescription>
                  </div>
                  <Switch
                    checked={draft?.debug ?? false}
                    onCheckedChange={(value) => updateDraft({ debug: value })}
                  />
                </div>
              </div>
            </FieldGroup>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Play className="size-4" />
                服务控制
              </CardTitle>
              <CardDescription>{status?.serve.message || "服务未启动"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void run(async () => {
                    if (draft) await saveWecomBridgeSettings(draft)
                    return startWecomBridgeServe()
                  })}
                  disabled={working || !canStart || status?.serve.state === "running"}
                >
                  <Play className="size-4" />
                  启动服务
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void run(stopWecomBridgeServe)}
                  disabled={working || !status || status.serve.state === "idle"}
                >
                  <Square className="size-4" />
                  停止服务
                </Button>
              </div>
              {!canStart ? (
                <p className="text-xs text-destructive">请先填写 Bot ID 和 Secret。</p>
              ) : null}
              <div className="space-y-2">
                {status?.commands.map((command, index) => (
                  <div
                    key={command}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2"
                  >
                    <code className="min-w-0 flex-1 truncate text-xs">{command}</code>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="复制命令"
                      onClick={() => void copyText(command, `命令 ${index + 1}`)}
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <CheckCircle2 className="size-4" />
                诊断
              </CardTitle>
              <CardDescription>检查源码、凭据、tsx loader、Codex 命令和服务进程</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {status?.diagnostics.map((item) => (
                <div key={item.key} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">{item.label}</span>
                    <DiagnosticBadge state={item.state} />
                  </div>
                  <p className="mt-1 break-all text-xs text-muted-foreground">{item.detail}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquareText className="size-4" />
              常用命令
            </CardTitle>
            <CardDescription>企业微信里可直接发送这些命令</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-2">
            {status?.commandHelp.map((item) => (
              <div key={item.command} className="rounded-md border border-border p-3">
                <code className="text-xs font-semibold">{item.command}</code>
                <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TerminalSquare className="size-4" />
              运行日志
            </CardTitle>
            <CardDescription>显示最近一段企业微信服务日志，完整日志保存在本地目录</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2">
              <PathLine label="状态文件" value={status?.paths.settingsPath || ""} />
              <PathLine label="日志目录" value={status?.paths.logDir || ""} />
              <PathLine label="服务锁" value={status?.paths.serveLockPath || ""} />
            </div>
            <Textarea
              readOnly
              value={logs || "暂无日志"}
              className="h-[340px] resize-none font-mono text-xs"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
