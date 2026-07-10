"use client"

import { useEffect, useMemo, useState } from "react"
import { ExternalLink, Loader2, Power, X } from "lucide-react"
import { FloatingDevtoolsGuard } from "@/components/floating-devtools-guard"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ReasoningBadge } from "@/components/status-badges"
import {
  REASONING_LABELS,
  type ConsoleSnapshot,
  type ReasoningEffort,
} from "@/lib/types"
import { isChatModel } from "@/lib/model-capabilities"
import { cn } from "@/lib/utils"

const REASONING_OPTIONS: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]

declare global {
  interface Window {
    codexHotSwitchFloating?: {
      send: (channel: string, message: unknown) => void
      onDesktopMessage?: (callback: (message: unknown) => void) => () => void
    }
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  throw new Error(body?.error || `${response.status} ${response.statusText}`)
}

async function fetchSnapshot() {
  return parseResponse<ConsoleSnapshot>(
    await fetch("/api/console", { cache: "no-store" }),
  )
}

async function patchRuntime(body: Record<string, unknown>) {
  return parseResponse<ConsoleSnapshot>(
    await fetch("/api/runtime", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
}

function postMessage(type: string, payload?: unknown) {
  window.codexHotSwitchFloating?.send("codex-hot-switch-floating-panel", {
    type,
    payload,
  })
}

function notifyConsoleChanged(source: string) {
  window.codexHotSwitchFloating?.send("codex-hot-switch-console", {
    type: "console-changed",
    payload: { source },
  })
}

export function FloatingPanelView() {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const rootBackground = document.documentElement.style.background
    const bodyBackground = document.body.style.background
    const bodyOverflow = document.body.style.overflow
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"
    document.body.style.overflow = "hidden"

    let active = true
    const load = async () => {
      try {
        const next = await fetchSnapshot()
        if (active) {
          setSnapshot(next)
          setError(null)
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    const timer = window.setInterval(load, 3000)
    return () => {
      active = false
      window.clearInterval(timer)
      document.documentElement.style.background = rootBackground
      document.body.style.background = bodyBackground
      document.body.style.overflow = bodyOverflow
    }
  }, [])

  const runtime = snapshot?.runtime
  const providers = useMemo(
    () =>
      snapshot?.providers.filter(
        (provider) =>
          provider.enabled &&
          snapshot.models.some(
            (model) =>
              model.providerId === provider.id &&
              model.enabled &&
              isChatModel(model),
          ),
      ) ?? [],
    [snapshot],
  )
  const models = useMemo(
    () =>
      snapshot && runtime
        ? snapshot.models.filter(
            (item) =>
              item.providerId === runtime.activeProviderId &&
              item.enabled &&
              isChatModel(item),
          )
        : [],
    [runtime, snapshot],
  )
  const provider = snapshot?.providers.find((item) => item.id === runtime?.activeProviderId)
  const model = snapshot?.models.find((item) => item.id === runtime?.activeModelId)
  const takeoverActive = runtime?.takeover === "active"

  async function apply(body: Record<string, unknown>) {
    setSaving(true)
    try {
      const next = await patchRuntime(body)
      setSnapshot(next)
      setError(null)
      notifyConsoleChanged("floating-panel")
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function changeProvider(providerId: string | null) {
    if (!providerId || !snapshot || !runtime) return
    const firstModel = snapshot.models.find(
      (item) => item.providerId === providerId && item.enabled && isChatModel(item),
    )
    if (!firstModel) {
      setError("该供应商暂无可用模型")
      return
    }
    await apply({
      activeProviderId: providerId,
      activeModelId: firstModel.id,
      reasoning: firstModel.supportsReasoning ? runtime.reasoning : "off",
    })
  }

  async function changeModel(modelId: string | null) {
    if (!modelId || !snapshot || !runtime) return
    const nextModel = snapshot.models.find((item) => item.id === modelId)
    if (!nextModel) return
    await apply({
      activeProviderId: nextModel.providerId,
      activeModelId: nextModel.id,
      reasoning: nextModel.supportsReasoning ? runtime.reasoning : "off",
    })
  }

  async function changeTakeover(checked: boolean) {
    await apply({ takeover: checked ? "active" : "paused" })
  }

  return (
    <main className="h-dvh w-dvw overflow-hidden bg-transparent p-2">
      <FloatingDevtoolsGuard />
      <section className="flex h-full flex-col rounded-lg border border-border bg-popover/96 text-popover-foreground shadow-xl shadow-black/20 backdrop-blur-md">
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">热切换</div>
            <div className="truncate text-xs text-muted-foreground">
              {provider?.name ?? "读取中"} / {model?.displayName ?? "未选择"}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="打开控制台"
              onClick={() => postMessage("open-console")}
            >
              <ExternalLink />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="关闭面板"
              onClick={() => postMessage("hide-panel")}
            >
              <X />
            </Button>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
          {!snapshot || !runtime ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              读取配置
            </div>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">供应商</span>
                <Select
                  value={runtime.activeProviderId}
                  onValueChange={(value) => void changeProvider(value)}
                >
                  <SelectTrigger className="h-8 w-full" disabled={saving}>
                    <SelectValue placeholder="选择供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {providers.map((item) => (
                        <SelectItem
                          key={item.id}
                          value={item.id}
                          disabled={item.health === "down"}
                        >
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">模型</span>
                <Select
                  value={runtime.activeModelId}
                  onValueChange={(value) => void changeModel(value)}
                >
                  <SelectTrigger className="h-8 w-full" disabled={saving}>
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {models.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.displayName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">推理强度</span>
                <Select
                  value={model?.supportsReasoning ? runtime.reasoning : "off"}
                  onValueChange={(value) =>
                    void apply({ reasoning: value as ReasoningEffort })
                  }
                >
                  <SelectTrigger
                    className="h-8 w-full"
                    disabled={saving || !model?.supportsReasoning}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {REASONING_OPTIONS.map((item) => (
                        <SelectItem key={item} value={item}>
                          {REASONING_LABELS[item]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </label>

              <div className="rounded-md border border-border bg-muted/40 p-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div
                      className={cn(
                        "flex items-center gap-1.5 text-xs font-medium",
                        takeoverActive ? "text-emerald-600" : "text-muted-foreground",
                      )}
                    >
                      <Power className="size-3.5 shrink-0" />
                      {takeoverActive ? "接管请求" : "透传请求"}
                    </div>
                    <div className="mt-1 truncate text-[11px] text-muted-foreground">
                      {takeoverActive ? "按当前供应商与模型重写" : "不改模型和 reasoning"}
                    </div>
                  </div>
                  <Switch
                    size="sm"
                    checked={takeoverActive}
                    disabled={saving}
                    aria-label={takeoverActive ? "关闭请求接管" : "开启请求接管"}
                    onCheckedChange={(checked) => void changeTakeover(checked)}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <ReasoningBadge effort={model?.supportsReasoning ? runtime.reasoning : "off"} />
                  <span className="text-[11px] text-muted-foreground">
                    {saving ? "保存中" : "立即生效"}
                  </span>
                </div>
              </div>
            </>
          )}

          {error ? (
            <div className="rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <footer className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
          <span>{saving ? "正在保存" : "立即生效"}</span>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
        </footer>
      </section>
    </main>
  )
}
