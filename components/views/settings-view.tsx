"use client"

import { useEffect, useRef, useState } from "react"
import { CircleDot, Download, ImageIcon, LifeBuoy, RefreshCw, Upload, Save } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { useConsole } from "@/lib/console-store"
import {
  isChatModel,
  isImageGenerationModel,
} from "@/lib/model-capabilities"
import {
  exportConsoleConfig,
  importConsoleConfig,
  updateFloatingBallSettings,
} from "@/lib/console-api"
import { REASONING_LABELS, type ReasoningEffort } from "@/lib/types"
import { toast } from "sonner"

const REASONING_OPTIONS: ReasoningEffort[] = ["off", "low", "medium", "high", "xhigh", "auto"]

declare global {
  interface Window {
    codexHotSwitchFloating?: {
      send: (channel: string, message: unknown) => void
      onDesktopMessage?: (callback: (message: unknown) => void) => () => void
    }
  }
}

export function SettingsView() {
  const { settings, providers, modelsByProvider, updateSettings, replaceSnapshot } =
    useConsole()
  const [draft, setDraft] = useState(settings)
  const [restartingServer, setRestartingServer] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setDraft(settings)
  }, [settings])

  const portError =
    draft.port < 1 || draft.port > 65535 ? "端口需介于 1 - 65535" : undefined
  const addrError = !draft.listenAddress.trim() ? "监听地址不能为空" : undefined
  const retentionError =
    draft.logRetentionDays < 1 ? "日志保留时间至少为 1 天" : undefined
  const imageModelError =
    !draft.imageGenerationProviderId || !draft.imageGenerationModelId
      ? "请选择生图供应商和模型"
      : undefined
  const auxiliaryModelError =
    draft.auxiliaryRoutingEnabled &&
    (!draft.auxiliaryProviderId || !draft.auxiliaryModelId)
      ? "请选择辅助供应商和模型"
      : undefined

  const chatProviders = providers.filter((provider) =>
    modelsByProvider(provider.id).some(isChatModel),
  )
  const defaultModels = modelsByProvider(draft.defaultProviderId).filter(isChatModel)
  const imageProviders = providers.filter((provider) =>
    provider.protocol === "openai-responses" &&
    modelsByProvider(provider.id).some(isImageGenerationModel),
  )
  const imageModels = modelsByProvider(draft.imageGenerationProviderId).filter(
    isImageGenerationModel,
  )
  const auxiliaryModels = modelsByProvider(draft.auxiliaryProviderId).filter(isChatModel)
  const valid =
    !portError &&
    !addrError &&
    !retentionError &&
    !imageModelError &&
    !auxiliaryModelError

  function handleProviderChange(value: string | null) {
    if (!value) return
    setDraft((d) => ({
      ...d,
      defaultProviderId: value,
      defaultModelId: modelsByProvider(value).find(isChatModel)?.id ?? "",
    }))
  }

  function handleImageProviderChange(value: string | null) {
    if (!value) return
    setDraft((d) => ({
      ...d,
      imageGenerationProviderId: value,
      imageGenerationModelId: modelsByProvider(value).find(isImageGenerationModel)?.id ?? "",
    }))
  }

  function handleAuxiliaryProviderChange(value: string | null) {
    if (!value) return
    setDraft((d) => ({
      ...d,
      auxiliaryProviderId: value,
      auxiliaryModelId: modelsByProvider(value).find(isChatModel)?.id ?? "",
    }))
  }

  function handleSave() {
    if (!valid) {
      toast.error("请修正设置中的错误后再保存")
      return
    }
    updateSettings(draft)
    toast.success("设置已保存。监听地址或端口会在重启服务后生效。")
  }

  async function handleFloatingBallChange(enabled: boolean) {
    setDraft((d) => ({ ...d, floatingBallEnabled: enabled }))
    try {
      const next = await updateFloatingBallSettings({ floatingBallEnabled: enabled })
      replaceSnapshot(next)
      setDraft((d) => ({
        ...d,
        floatingBallEnabled: next.settings.floatingBallEnabled,
        floatingBallPosition: next.settings.floatingBallPosition,
      }))
      window.codexHotSwitchFloating?.send("codex-hot-switch-console", {
        type: "console-changed",
        payload: { source: "settings-floating-ball" },
      })
      toast.success(enabled ? "悬浮球已开启" : "悬浮球已关闭")
    } catch (error) {
      setDraft(settings)
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  function handleRestartServer() {
    const bridge = window.codexHotSwitchFloating
    if (!bridge) {
      toast.error("只能在安装版桌面壳里重启本地服务")
      return
    }
    setRestartingServer(true)
    bridge.send("codex-hot-switch-console", { type: "restart-server" })
    toast.success("正在重启本地中转服务")
    window.setTimeout(() => setRestartingServer(false), 2500)
  }

  function handleExport() {
    exportConsoleConfig()
    toast.success("正在导出配置")
  }
  async function handleImport(file: File | undefined) {
    if (!file) return
    try {
      const snapshot = await importConsoleConfig(file)
      replaceSnapshot(snapshot)
      setDraft(snapshot.settings)
      toast.success("配置已导入")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">设置</h1>
          <p className="text-sm text-muted-foreground">
            配置本地中转服务的监听、接管默认配置与日志保留
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => void handleImport(event.target.files?.[0])}
          />
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
            <Upload data-icon="inline-start" />
            导入
          </Button>
          <Button variant="outline" onClick={handleExport}>
            <Download data-icon="inline-start" />
            导出
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">本地服务</CardTitle>
              <CardDescription>中转服务监听地址与接管开关</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRestartServer}
              disabled={restartingServer}
            >
              <RefreshCw
                data-icon="inline-start"
                className={restartingServer ? "animate-spin" : undefined}
              />
              重启服务
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!addrError}>
                <FieldLabel htmlFor="s-addr">本地监听地址</FieldLabel>
                <Input
                  id="s-addr"
                  value={draft.listenAddress}
                  aria-invalid={!!addrError}
                  className="font-mono text-sm"
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, listenAddress: e.target.value }))
                  }
                />
                {addrError ? <FieldError>{addrError}</FieldError> : null}
              </Field>
              <Field data-invalid={!!portError}>
                <FieldLabel htmlFor="s-port">端口</FieldLabel>
                <Input
                  id="s-port"
                  type="number"
                  value={draft.port}
                  aria-invalid={!!portError}
                  className="font-mono text-sm"
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, port: Number(e.target.value) }))
                  }
                />
                {portError ? (
                  <FieldError>{portError}</FieldError>
                ) : (
                  <FieldDescription>
                    中转地址：http://{draft.listenAddress}:{draft.port}/v1；非本机监听需设置
                    CODEX_HOT_SWITCH_ALLOW_LAN=1。
                  </FieldDescription>
                )}
              </Field>
            </div>
            <Separator />
            <Field orientation="horizontal">
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="s-takeover">启用请求接管</FieldLabel>
                <FieldDescription>
                  关闭后中转层透传请求，不做任何模型或 reasoning 重写。
                </FieldDescription>
              </div>
              <Switch
                id="s-takeover"
                checked={draft.takeoverEnabled}
                onCheckedChange={(v) =>
                  setDraft((d) => ({ ...d, takeoverEnabled: v }))
                }
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CircleDot className="size-4" />
            桌面悬浮球
          </CardTitle>
          <CardDescription>在 EXE 运行时显示桌面热切换入口</CardDescription>
        </CardHeader>
        <CardContent>
          <Field orientation="horizontal">
            <div className="flex flex-col gap-0.5">
              <FieldLabel htmlFor="s-floating-ball">显示桌面悬浮球</FieldLabel>
              <FieldDescription>
                悬浮球可右键隐藏；重新开启后会恢复到上次拖放的位置。
              </FieldDescription>
            </div>
            <Switch
              id="s-floating-ball"
              checked={draft.floatingBallEnabled}
              onCheckedChange={(value) => void handleFloatingBallChange(value)}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">接管默认配置</CardTitle>
          <CardDescription>
            模型和 reasoning 只在请求接管开启时使用；关闭接管时仅使用供应商作为透传出口。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="s-provider">默认出口供应商</FieldLabel>
                <Select value={draft.defaultProviderId} onValueChange={handleProviderChange}>
                  <SelectTrigger id="s-provider" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {chatProviders.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  关闭接管时，请求会透传到这个供应商。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="s-model">接管默认模型</FieldLabel>
                <Select
                  value={draft.defaultModelId}
                  onValueChange={(v) => {
                    if (!v) return
                    setDraft((d) => ({ ...d, defaultModelId: v }))
                  }}
                >
                  <SelectTrigger id="s-model" className="w-full">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {defaultModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.displayName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  用于恢复热切换默认配置，不影响透传请求。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="s-reasoning">接管默认 reasoning</FieldLabel>
                <Select
                  value={draft.defaultReasoning}
                  onValueChange={(v) => {
                    if (!v) return
                    setDraft((d) => ({ ...d, defaultReasoning: v as ReasoningEffort }))
                  }}
                >
                  <SelectTrigger id="s-reasoning" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {REASONING_OPTIONS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {REASONING_LABELS[o]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  请求接管关闭时保留 Codex 原始 reasoning。
                </FieldDescription>
              </Field>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon className="size-4" />
            工具模型
          </CardTitle>
          <CardDescription>
            请求接管开启时，为 Responses 的 image_generation 工具指定专用模型。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!imageModelError}>
                <FieldLabel htmlFor="s-image-provider">生图供应商</FieldLabel>
                <Select
                  value={draft.imageGenerationProviderId}
                  onValueChange={handleImageProviderChange}
                >
                  <SelectTrigger id="s-image-provider" className="w-full">
                    <SelectValue placeholder="选择供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {imageProviders.length === 0 ? (
                        <SelectItem value="__none" disabled>
                          暂无生图供应商
                        </SelectItem>
                      ) : (
                        imageProviders.map((provider) => (
                          <SelectItem key={provider.id} value={provider.id}>
                            {provider.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field data-invalid={!!imageModelError}>
                <FieldLabel htmlFor="s-image-model">生图模型</FieldLabel>
                <Select
                  value={draft.imageGenerationModelId}
                  onValueChange={(value) => {
                    if (!value) return
                    setDraft((d) => ({ ...d, imageGenerationModelId: value }))
                  }}
                >
                  <SelectTrigger id="s-image-model" className="w-full">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {imageModels.length === 0 ? (
                        <SelectItem value="__none" disabled>
                          该供应商暂无生图模型
                        </SelectItem>
                      ) : (
                        imageModels.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.displayName}
                          </SelectItem>
                        ))
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {imageModelError ? (
              <FieldError>{imageModelError}</FieldError>
            ) : (
              <FieldDescription>
                生图请求会走这里选择的 OpenAI Responses 兼容供应商，并把 image_generation 的 model 写成该模型真实 ID。
              </FieldDescription>
            )}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LifeBuoy className="size-4" />
            辅助模型
          </CardTitle>
          <CardDescription>
            请求接管开启时，为 Codex 记忆整理等后台任务指定更轻的模型。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field orientation="horizontal">
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="s-aux-enabled">启用辅助模型路由</FieldLabel>
                <FieldDescription>
                  命中 Memory Writing Agent、Consolidation、.codex\\memories 等后台标签时生效。
                </FieldDescription>
              </div>
              <Switch
                id="s-aux-enabled"
                checked={draft.auxiliaryRoutingEnabled}
                onCheckedChange={(value) =>
                  setDraft((d) => ({ ...d, auxiliaryRoutingEnabled: value }))
                }
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field data-invalid={!!auxiliaryModelError}>
                <FieldLabel htmlFor="s-aux-provider">辅助供应商</FieldLabel>
                <Select
                  value={draft.auxiliaryProviderId}
                  onValueChange={handleAuxiliaryProviderChange}
                >
                  <SelectTrigger id="s-aux-provider" className="w-full">
                    <SelectValue placeholder="选择供应商" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {chatProviders.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field data-invalid={!!auxiliaryModelError}>
                <FieldLabel htmlFor="s-aux-model">辅助模型</FieldLabel>
                <Select
                  value={draft.auxiliaryModelId}
                  onValueChange={(value) => {
                    if (!value) return
                    setDraft((d) => ({ ...d, auxiliaryModelId: value }))
                  }}
                >
                  <SelectTrigger id="s-aux-model" className="w-full">
                    <SelectValue placeholder="选择模型" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {auxiliaryModels.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.displayName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="s-aux-reasoning">辅助 reasoning</FieldLabel>
                <Select
                  value={draft.auxiliaryReasoning}
                  onValueChange={(value) => {
                    if (!value) return
                    setDraft((d) => ({
                      ...d,
                      auxiliaryReasoning: value as ReasoningEffort,
                    }))
                  }}
                >
                  <SelectTrigger id="s-aux-reasoning" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {REASONING_OPTIONS.map((option) => (
                        <SelectItem key={option} value={option}>
                          {REASONING_LABELS[option]}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {auxiliaryModelError ? (
              <FieldError>{auxiliaryModelError}</FieldError>
            ) : (
              <FieldDescription>
                该规则只处理 Codex 裸模型名发出的记忆整理类后台请求，不影响显式选择的主模型。
              </FieldDescription>
            )}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">日志与存储</CardTitle>
          <CardDescription>日志保留时间与密钥存储方式</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!retentionError}>
                <FieldLabel htmlFor="s-retention">日志保留时间（天）</FieldLabel>
                <Input
                  id="s-retention"
                  type="number"
                  value={draft.logRetentionDays}
                  aria-invalid={!!retentionError}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      logRetentionDays: Number(e.target.value),
                    }))
                  }
                />
                {retentionError ? <FieldError>{retentionError}</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel htmlFor="s-keystore">API Key 存储方式</FieldLabel>
                <Input
                  id="s-keystore"
                  value={draft.keyStorage}
                  disabled
                  placeholder="系统钥匙串（占位）"
                />
                <FieldDescription>占位项，后续接入安全存储。</FieldDescription>
              </Field>
            </div>
            <Field orientation="horizontal">
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="s-full-logs">保存完整请求详情</FieldLabel>
                <FieldDescription>
                  默认关闭。开启后完整 raw/rewritten 请求按日志 ID 分文件保存；列表仍只保留摘要，避免状态文件膨胀。
                </FieldDescription>
              </div>
              <Switch
                id="s-full-logs"
                checked={draft.fullRequestLoggingEnabled === true}
                onCheckedChange={(value) =>
                  setDraft((d) => ({ ...d, fullRequestLoggingEnabled: value }))
                }
              />
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!valid}>
          <Save data-icon="inline-start" />
          保存设置
        </Button>
      </div>
    </div>
  )
}
