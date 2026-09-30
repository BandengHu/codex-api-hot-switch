"use client"

import { useEffect, useState } from "react"
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { useConsole } from "@/lib/console-store"
import {
  MODEL_CAPABILITY_OPTIONS,
  normalizeModelCapabilities,
} from "@/lib/model-capabilities"
import {
  REASONING_DIALECT_LABELS,
  REASONING_DIALECTS,
  type Model,
  type ModelReasoningDialect,
} from "@/lib/types"
import { toast } from "sonner"

function emptyModel(providerId: string): Model {
  return {
    id: `m-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    providerId,
    displayName: "",
    modelId: "",
    capabilities: ["chat"],
    contextLength: 128000,
    supportsReasoning: false,
    reasoningDialect: "inherit",
    supportsVision: false,
    enabled: true,
  }
}

function normalizeModelForForm(model: Model) {
  const capabilities = normalizeModelCapabilities([
    ...model.capabilities,
    ...(model.supportsReasoning ? ["reasoning"] : []),
    ...(model.supportsVision ? ["vision"] : []),
  ])
  return {
    ...model,
    capabilities,
    supportsReasoning: capabilities.includes("reasoning"),
    supportsVision: capabilities.includes("vision"),
  }
}

export function ModelFormDialog({
  open,
  onOpenChange,
  editing,
  initialProviderId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editing: Model | null
  initialProviderId?: string
}) {
  const { providers, addModel, updateModel } = useConsole()
  const [form, setForm] = useState<Model | null>(null)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (!open) return
    const providerId = initialProviderId || editing?.providerId || providers[0]?.id || ""
    const next = editing ? normalizeModelForForm(editing) : emptyModel(providerId)
    setForm(next)
    setTouched(false)
  }, [open, editing, initialProviderId, providers])

  if (!form) return null

  const providerError = touched && !form.providerId ? "请选择供应商" : undefined
  const nameError = touched && !form.displayName.trim() ? "请填写显示名" : undefined
  const modelError = touched && !form.modelId.trim() ? "请填写真实模型 ID" : undefined
  const parsedCapabilities = normalizeModelCapabilities(form.capabilities)
  const isChatCapable = parsedCapabilities.includes("chat")
  const minimumContextLength = isChatCapable ? 1000 : 0
  const contextError =
    touched &&
    (!Number.isFinite(form.contextLength) ||
      form.contextLength < minimumContextLength)
      ? isChatCapable
        ? "聊天模型上下文长度至少为 1000"
        : "上下文长度不能小于 0"
      : undefined

  function handleSubmit() {
    setTouched(true)
    const current = form
    if (!current) return
    if (
      !current.providerId ||
      !current.displayName.trim() ||
      !current.modelId.trim() ||
      !Number.isFinite(current.contextLength) ||
      current.contextLength < minimumContextLength
    ) {
      toast.error("请修正模型表单中的错误")
      return
    }
    const next = {
      ...current,
      displayName: current.displayName.trim(),
      modelId: current.modelId.trim(),
      capabilities: parsedCapabilities,
      supportsReasoning: parsedCapabilities.includes("reasoning"),
      supportsVision: parsedCapabilities.includes("vision"),
      contextLength: Math.round(current.contextLength),
    }
    editing ? updateModel(next) : addModel(next)
    onOpenChange(false)
    toast.success(editing ? "模型已更新" : "模型已新增")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑模型" : "新增模型"}</DialogTitle>
          <DialogDescription>
            填写供应商实际接受的模型 ID，并声明本地热切换需要用到的能力。
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="-mx-4 min-h-0 overflow-y-auto px-4 pb-1">
          <Field data-invalid={!!providerError}>
            <FieldLabel htmlFor="model-provider">供应商</FieldLabel>
            <Select
              value={form.providerId}
              onValueChange={(value) => {
                if (!value) return
                setForm((current) =>
                  current ? { ...current, providerId: value } : current,
                )
              }}
            >
              <SelectTrigger id="model-provider" className="w-full">
                <SelectValue placeholder="选择供应商" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {providerError ? <FieldError>{providerError}</FieldError> : null}
          </Field>

          <Field data-invalid={!!nameError}>
            <FieldLabel htmlFor="model-display-name">显示名</FieldLabel>
            <Input
              id="model-display-name"
              value={form.displayName}
              aria-invalid={!!nameError}
              placeholder="例如：DeepSeek R1"
              onChange={(event) =>
                setForm((current) =>
                  current ? { ...current, displayName: event.target.value } : current,
                )
              }
            />
            {nameError ? <FieldError>{nameError}</FieldError> : null}
          </Field>

          <Field data-invalid={!!modelError}>
            <FieldLabel htmlFor="model-real-id">真实模型 ID</FieldLabel>
            <Input
              id="model-real-id"
              value={form.modelId}
              aria-invalid={!!modelError}
              placeholder="例如：deepseek-v4-pro"
              className="font-mono text-sm"
              onChange={(event) =>
                setForm((current) =>
                  current ? { ...current, modelId: event.target.value } : current,
                )
              }
            />
            {modelError ? (
              <FieldError>{modelError}</FieldError>
            ) : (
              <FieldDescription>这里填写发给供应商 API 的 model 字段。</FieldDescription>
            )}
          </Field>

          <Field data-invalid={!!contextError}>
            <FieldLabel htmlFor="model-context">上下文长度</FieldLabel>
            <Input
              id="model-context"
              type="number"
              min={minimumContextLength}
              value={form.contextLength}
              aria-invalid={!!contextError}
              onChange={(event) =>
                setForm((current) =>
                  current
                    ? { ...current, contextLength: Number(event.target.value) }
                    : current,
                )
              }
            />
            {contextError ? <FieldError>{contextError}</FieldError> : null}
          </Field>

          <Field>
            <FieldLabel>能力标签</FieldLabel>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {MODEL_CAPABILITY_OPTIONS.map((option) => {
                const active = parsedCapabilities.includes(option.value)
                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant={active ? "default" : "outline"}
                    size="sm"
                    className="h-auto min-h-9 justify-start whitespace-normal px-2 py-2 text-left"
                    title={option.description}
                    aria-pressed={active}
                    onClick={() =>
                      setForm((current) => {
                        if (!current) return current
                        const currentCapabilities = normalizeModelCapabilities(
                          current.capabilities,
                        )
                        const nextCapabilities = active
                          ? currentCapabilities.filter(
                              (capability) => capability !== option.value,
                            )
                          : [...currentCapabilities, option.value]
                        const normalized = normalizeModelCapabilities(nextCapabilities)
                        return {
                          ...current,
                          capabilities: normalized,
                          supportsReasoning: normalized.includes("reasoning"),
                          supportsVision: normalized.includes("vision"),
                        }
                      })
                    }
                  >
                    {option.label}
                  </Button>
                )
              })}
            </div>
            <FieldDescription>
              已限制为内置能力，避免手输拼写错误；推理和视觉会同步对应开关。
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="model-reasoning-dialect">推理方言</FieldLabel>
            <Select
              value={form.reasoningDialect}
              onValueChange={(value) => {
                if (!value) return
                setForm((current) =>
                  current
                    ? {
                        ...current,
                        reasoningDialect: value as ModelReasoningDialect,
                      }
                    : current,
                )
              }}
            >
              <SelectTrigger id="model-reasoning-dialect" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="inherit">继承供应商</SelectItem>
                  {REASONING_DIALECTS.map((dialect) => (
                    <SelectItem key={dialect} value={dialect}>
                      {REASONING_DIALECT_LABELS[dialect]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <div className="grid gap-2">
            <Field
              orientation="horizontal"
              className="rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <FieldLabel htmlFor="model-supports-reasoning">
                  支持推理
                </FieldLabel>
                <FieldDescription>允许热切换写入 reasoning 参数。</FieldDescription>
              </div>
              <Switch
                id="model-supports-reasoning"
                checked={form.supportsReasoning}
                onCheckedChange={(value) =>
                  setForm((current) =>
                    current
                      ? {
                          ...current,
                          supportsReasoning: value,
                          capabilities: value
                            ? normalizeModelCapabilities([
                                ...current.capabilities,
                                "reasoning",
                              ])
                            : normalizeModelCapabilities(
                                current.capabilities.filter(
                                  (capability) => capability !== "reasoning",
                                ),
                              ),
                        }
                      : current,
                  )
                }
              />
            </Field>
            <Field
              orientation="horizontal"
              className="rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <FieldLabel htmlFor="model-supports-vision">
                  支持视觉
                </FieldLabel>
                <FieldDescription>模型可接收图片或多模态输入。</FieldDescription>
              </div>
              <Switch
                id="model-supports-vision"
                checked={form.supportsVision}
                onCheckedChange={(value) =>
                  setForm((current) =>
                    current
                      ? {
                          ...current,
                          supportsVision: value,
                          capabilities: value
                            ? normalizeModelCapabilities([
                                ...current.capabilities,
                                "vision",
                              ])
                            : normalizeModelCapabilities(
                                current.capabilities.filter(
                                  (capability) => capability !== "vision",
                                ),
                              ),
                        }
                      : current,
                  )
                }
              />
            </Field>
            <Field
              orientation="horizontal"
              className="rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <FieldLabel htmlFor="model-enabled">启用模型</FieldLabel>
                <FieldDescription>关闭后不参与热切换选择。</FieldDescription>
              </div>
              <Switch
                id="model-enabled"
                checked={form.enabled}
                onCheckedChange={(value) =>
                  setForm((current) =>
                    current ? { ...current, enabled: value } : current,
                  )
                }
              />
            </Field>
          </div>
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
