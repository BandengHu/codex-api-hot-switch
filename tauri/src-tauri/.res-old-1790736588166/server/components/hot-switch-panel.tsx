"use client"

import { CheckCircle2, RotateCcw, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
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
} from "@/components/ui/field"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { useConsole } from "@/lib/console-store"
import { isChatModel } from "@/lib/model-capabilities"
import { REASONING_LABELS, type ReasoningEffort } from "@/lib/types"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

const REASONING_OPTIONS: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"]

export function HotSwitchPanel({ compact = false }: { compact?: boolean }) {
  const {
    providers,
    runtime,
    modelsByProvider,
    getProvider,
    getModel,
    applySwitch,
    resetToDefault,
    saving,
  } = useConsole()

  const selectedProvider = getProvider(runtime.activeProviderId)
  const chatProviders = providers.filter((provider) =>
    modelsByProvider(provider.id).some(isChatModel),
  )
  const availableModels = modelsByProvider(runtime.activeProviderId).filter(isChatModel)
  const selectedModel = getModel(runtime.activeModelId)
  const providerUnavailable = selectedProvider ? !selectedProvider.enabled || selectedProvider.health === "down" : false
  const modelNoReasoning = selectedModel ? !selectedModel.supportsReasoning : false

  function applySelection(providerId: string, modelId: string, reasoning: ReasoningEffort) {
    const provider = getProvider(providerId)
    const model = getModel(modelId)
    if (!provider || !model) {
      toast.error("请选择有效的供应商和模型")
      return
    }
    if (!provider.enabled || provider.health === "down") {
      toast.error(`供应商「${provider.name}」当前不可用`)
      return
    }

    applySwitch(providerId, modelId, model.supportsReasoning ? reasoning : "off")
  }

  function handleProviderChange(value: string | null) {
    if (!value) return
    const firstModel = modelsByProvider(value).find(
      (model) => model.enabled && isChatModel(model),
    )
    if (!firstModel) {
      toast.error("该供应商暂无可用模型")
      return
    }
    applySelection(value, firstModel.id, runtime.reasoning)
  }

  function handleReset() {
    resetToDefault()
    toast.success("已恢复接管默认配置")
  }

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup className={cn(compact ? "gap-4" : "gap-5")}>
        <div className={cn("grid gap-4", compact ? "sm:grid-cols-2" : "lg:grid-cols-2")}>
          <Field>
            <FieldLabel htmlFor="hs-provider">供应商</FieldLabel>
            <Select value={runtime.activeProviderId} onValueChange={handleProviderChange}>
              <SelectTrigger id="hs-provider" className="w-full">
                <SelectValue placeholder="选择供应商" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {chatProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id} disabled={!p.enabled || p.health === "down"}>
                      {p.name}
                      {!p.enabled ? "（已停用）" : p.health === "down" ? "（不可用）" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {providerUnavailable ? (
              <FieldDescription className="text-destructive">
                该供应商当前不可用：{selectedProvider?.healthMessage ?? "已停用或健康检查失败"}
              </FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="hs-model">模型</FieldLabel>
            <Select
              value={runtime.activeModelId}
              onValueChange={(value) => value && applySelection(runtime.activeProviderId, value, runtime.reasoning)}
            >
              <SelectTrigger id="hs-model" className="w-full">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {availableModels.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      该供应商暂无模型
                    </SelectItem>
                  ) : (
                    availableModels.map((m) => (
                      <SelectItem key={m.id} value={m.id} disabled={!m.enabled}>
                        {m.displayName}
                        {!m.enabled ? "（已停用）" : ""}
                      </SelectItem>
                    ))
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field data-disabled={modelNoReasoning || undefined}>
          <FieldLabel>推理强度</FieldLabel>
          <ToggleGroup
            value={[modelNoReasoning ? "off" : runtime.reasoning]}
            onValueChange={(v) => {
              const next = v[0]
              if (next) applySelection(runtime.activeProviderId, runtime.activeModelId, next as ReasoningEffort)
            }}
            disabled={modelNoReasoning}
            className="w-full"
          >
            {REASONING_OPTIONS.map((opt) => (
              <ToggleGroupItem key={opt} value={opt} className="flex-1">
                {REASONING_LABELS[opt]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {modelNoReasoning ? (
            <FieldDescription className="text-destructive">
              模型「{selectedModel?.displayName}」不支持 reasoning，推理强度已锁定为「关闭」。
            </FieldDescription>
          ) : (
            <FieldDescription>
              无论 Codex 请求携带何种 reasoning 参数，都会被重写为此强度。
            </FieldDescription>
          )}
        </Field>
      </FieldGroup>

      {providerUnavailable ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>当前选择的供应商不可用</AlertTitle>
          <AlertDescription>
            应用前请在「供应商」页面恢复其健康状态，或改选其他供应商。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={handleReset}>
          <RotateCcw data-icon="inline-start" />
          恢复接管默认配置
        </Button>
        <span className="inline-flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm text-muted-foreground">
          {saving ? <Spinner data-icon="inline-start" /> : <CheckCircle2 className="size-4 text-emerald-600" />}
          {saving ? "正在保存" : "当前已启用"}
        </span>
      </div>
    </div>
  )
}
