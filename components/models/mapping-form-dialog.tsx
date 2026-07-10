"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
import { Switch } from "@/components/ui/switch"
import { useConsole } from "@/lib/console-store"
import { isChatModel } from "@/lib/model-capabilities"
import {
  REASONING_LABELS,
  type ModelMapping,
  type ReasoningEffort,
} from "@/lib/types"
import { toast } from "sonner"

const OVERRIDE_OPTIONS: (ReasoningEffort | "inherit")[] = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]

function overrideLabel(v: ReasoningEffort | "inherit") {
  return v === "inherit" ? "继承请求" : REASONING_LABELS[v]
}

export function MappingFormDialog({
  open,
  onOpenChange,
  editing,
  nextPriority,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editing: ModelMapping | null
  nextPriority: number
}) {
  const { providers, models, modelsByProvider, addMapping, updateMapping } = useConsole()
  const [form, setForm] = useState<ModelMapping | null>(null)
  const [touched, setTouched] = useState(false)
  const chatProviders = useMemo(
    () =>
      providers.filter((provider) =>
        models.some((model) => model.providerId === provider.id && isChatModel(model)),
      ),
    [providers, models],
  )

  useEffect(() => {
    if (open) {
      const fallbackProviderId =
        editing?.targetProviderId || chatProviders[0]?.id || ""
      setTouched(false)
      setForm(
        editing ?? {
          id: `map-${Date.now()}`,
          codexModel: "",
          targetProviderId: fallbackProviderId,
          targetModelId:
            modelsByProvider(fallbackProviderId).find(isChatModel)?.id ?? "",
          reasoningOverride: "inherit",
          priority: nextPriority,
          enabled: true,
        },
      )
    }
  }, [open, editing, chatProviders, nextPriority, modelsByProvider])

  if (!form) return null

  const codexError =
    touched && !form.codexModel.trim() ? "请填写 Codex 请求模型名" : undefined
  const targetModels = modelsByProvider(form.targetProviderId).filter(isChatModel)

  function handleProviderChange(value: string | null) {
    if (!value) return
    setForm((f) =>
      f
        ? {
            ...f,
            targetProviderId: value,
            targetModelId: modelsByProvider(value).find(isChatModel)?.id ?? "",
          }
        : f,
    )
  }

  function handleSubmit() {
    setTouched(true)
    if (!form) return
    if (!form.codexModel.trim() || !form.targetModelId) {
      toast.error("请完善映射规则的必填字段")
      return
    }
    editing ? updateMapping(form) : addMapping(form)
    onOpenChange(false)
    toast.success(editing ? "映射规则已更新" : "映射规则已新增")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑映射规则" : "新增映射规则"}</DialogTitle>
          <DialogDescription>
            将 Codex 请求的模型强制映射到指定供应商与模型。
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="-mx-4 min-h-0 overflow-y-auto px-4 pb-1">
          <Field data-invalid={!!codexError}>
            <FieldLabel htmlFor="m-codex">Codex 请求模型</FieldLabel>
            <Input
              id="m-codex"
              value={form.codexModel}
              aria-invalid={!!codexError}
              placeholder="例如：gpt-5.5"
              className="font-mono text-sm"
              onChange={(e) =>
                setForm((f) => (f ? { ...f, codexModel: e.target.value } : f))
              }
            />
            {codexError ? (
              <FieldError>{codexError}</FieldError>
            ) : (
              <FieldDescription>匹配 Codex 实际发出的模型名。</FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="m-provider">实际供应商</FieldLabel>
            <Select value={form.targetProviderId} onValueChange={handleProviderChange}>
              <SelectTrigger id="m-provider" className="w-full">
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
          </Field>

          <Field>
            <FieldLabel htmlFor="m-model">实际模型</FieldLabel>
              <Select
                value={form.targetModelId}
              onValueChange={(v) => {
                if (!v) return
                setForm((f) => (f ? { ...f, targetModelId: v } : f))
              }}
            >
              <SelectTrigger id="m-model" className="w-full">
                <SelectValue placeholder="选择模型" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {targetModels.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      该供应商暂无模型
                    </SelectItem>
                  ) : (
                    targetModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.displayName}
                      </SelectItem>
                    ))
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="m-reasoning">reasoning 强度覆盖</FieldLabel>
            <Select
              value={form.reasoningOverride}
              onValueChange={(v) => {
                if (!v) return
                setForm((f) =>
                  f ? { ...f, reasoningOverride: v as ReasoningEffort | "inherit" } : f,
                )
              }}
            >
              <SelectTrigger id="m-reasoning" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {OVERRIDE_OPTIONS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {overrideLabel(o)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              「继承请求」表示沿用 Codex 原始 reasoning 参数。
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="m-priority">优先级（数字越小越优先）</FieldLabel>
            <Input
              id="m-priority"
              type="number"
              min={1}
              value={form.priority}
              onChange={(e) =>
                setForm((f) =>
                  f ? { ...f, priority: Number(e.target.value) } : f,
                )
              }
            />
          </Field>

          <Field orientation="horizontal">
            <div className="flex flex-col gap-0.5">
              <FieldLabel htmlFor="m-enabled">启用该规则</FieldLabel>
              <FieldDescription>停用后该映射不参与匹配。</FieldDescription>
            </div>
            <Switch
              id="m-enabled"
              checked={form.enabled}
              onCheckedChange={(v) =>
                setForm((f) => (f ? { ...f, enabled: v } : f))
              }
            />
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit}>{editing ? "保存" : "新增"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
