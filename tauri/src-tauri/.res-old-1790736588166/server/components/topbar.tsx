"use client"

import { Moon, Sun, Copy, Check, Loader2, AlertCircle } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useConsole } from "@/lib/console-store"
import { useTheme } from "@/lib/theme-provider"
import { REASONING_LABELS } from "@/lib/types"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

export function Topbar() {
  const { runtime, getProvider, getModel, settings, saving, error } = useConsole()
  const { theme, toggle } = useTheme()
  const [copied, setCopied] = useState(false)

  const provider = getProvider(runtime.activeProviderId)
  const model = getModel(runtime.activeModelId)
  const isActive = runtime.takeover === "active"
  const endpoint = `http://${settings.listenAddress}:${settings.port}/v1`

  function copyEndpoint() {
    navigator.clipboard.writeText(endpoint)
    setCopied(true)
    toast.success("已复制本地中转地址")
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-2 rounded-full",
            isActive ? "bg-chart-1" : "bg-muted-foreground",
          )}
          aria-hidden
        />
        <span className="text-sm font-medium">
          {isActive ? "正在接管 Codex 请求" : "接管已暂停"}
        </span>
      </div>

      <Separator orientation="vertical" className="h-6" />

      <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <span className="hidden truncate sm:inline">
          <span className="text-foreground">{provider?.name ?? "—"}</span>
          <span className="mx-1.5 text-border">/</span>
          <span className="text-foreground">{model?.displayName ?? "—"}</span>
        </span>
        <Badge variant="secondary" className="font-normal">
          推理 · {REASONING_LABELS[runtime.reasoning]}
        </Badge>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {saving ? (
          <Badge variant="outline" className="hidden gap-1 font-normal md:inline-flex">
            <Loader2 className="size-3 animate-spin" />
            保存中
          </Badge>
        ) : null}
        {error ? (
          <Badge variant="destructive" className="hidden gap-1 font-normal md:inline-flex">
            <AlertCircle className="size-3" />
            {error}
          </Badge>
        ) : null}
        <button
          type="button"
          onClick={copyEndpoint}
          className="hidden items-center gap-1.5 rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground md:flex"
        >
          {endpoint}
          {copied ? (
            <Check className="size-3.5 text-chart-1" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </button>
        <Button variant="outline" size="icon" onClick={toggle} aria-label="切换主题">
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </div>
    </header>
  )
}
