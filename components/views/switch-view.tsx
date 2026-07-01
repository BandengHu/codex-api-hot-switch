"use client"

import { Zap, Info, ShieldCheck } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { HotSwitchPanel } from "@/components/hot-switch-panel"
import {
  HealthBadge,
  ProtocolBadge,
  ReasoningBadge,
} from "@/components/status-badges"
import { useConsole } from "@/lib/console-store"

export function SwitchView() {
  const { runtime, getProvider, getModel } = useConsole()
  const provider = getProvider(runtime.activeProviderId)
  const model = getModel(runtime.activeModelId)
  const isActive = runtime.takeover === "active"

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold">热切换</h1>
        <p className="text-sm text-muted-foreground">
          快速调整运行时转发策略，应用后立即对所有 Codex 请求生效
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-4 py-3">
        <span
          className={
            isActive
              ? "size-2 shrink-0 rounded-full bg-chart-1"
              : "size-2 shrink-0 rounded-full bg-muted-foreground"
          }
          aria-hidden
        />
        <Zap className="size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm font-medium">
          {isActive ? "当前正在接管所有 Codex 请求" : "接管已暂停，请求将直连原始供应商"}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">运行时策略</CardTitle>
            <CardDescription>选择供应商、模型与推理强度后应用</CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6">
            <HotSwitchPanel />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">当前生效配置</CardTitle>
            <CardDescription>顶部状态栏与此处保持同步</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">供应商</span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{provider?.name ?? "—"}</span>
                {provider ? <HealthBadge status={provider.health} /> : null}
              </div>
              {provider ? <ProtocolBadge protocol={provider.protocol} /> : null}
            </div>
            <Separator />
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">模型</span>
              <span className="text-sm font-medium">{model?.displayName ?? "—"}</span>
              <code className="font-mono text-xs text-muted-foreground">
                {model?.modelId ?? "—"}
              </code>
            </div>
            <Separator />
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">推理强度</span>
              <div>
                <ReasoningBadge effort={runtime.reasoning} />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Alert>
        <ShieldCheck />
        <AlertTitle>请求源不变，仅在本地中转层重写</AlertTitle>
        <AlertDescription>
          切换不会修改 Codex 的请求源或本机配置。Codex 仍向本地中转地址发送请求，
          所有模型、reasoning 参数的改写都发生在中转层，对 Codex 完全透明。
        </AlertDescription>
      </Alert>
    </div>
  )
}
