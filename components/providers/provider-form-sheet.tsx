"use client"

import { useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
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
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group"
import { Separator } from "@/components/ui/separator"
import {
  PROTOCOL_LABELS,
  REASONING_DIALECT_LABELS,
  REASONING_DIALECTS,
  type Provider,
  type ProtocolType,
  type HeaderEntry,
  type Model,
  type ReasoningDialect,
} from "@/lib/types"
import {
  PROVIDER_PRESETS,
  createProviderPresetDraft,
  findProviderPreset,
} from "@/lib/provider-presets"
import { cloneFormCopy, type ProviderCloneDraft } from "@/lib/provider-clone"
import { toast } from "sonner"

const PROTOCOLS: ProtocolType[] = [
  "openai-responses",
  "openai-chat",
  "anthropic",
  "gemini",
]

function emptyProvider(): Provider {
  return {
    id: `prov-${Date.now()}`,
    name: "",
    protocol: "openai-responses",
    baseUrl: "",
    apiKey: "",
    headers: [],
    bodyOverride: "",
    timeoutMs: 60000,
    reasoningDialect: "auto",
    rawResponsesPassthrough: false,
    enabled: true,
    isDefault: false,
    health: "healthy",
  }
}

export function ProviderFormSheet({
  open,
  onOpenChange,
  editing,
  cloneDraft,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editing: Provider | null
  cloneDraft?: ProviderCloneDraft | null
  onSubmit: (p: Provider, models?: Model[]) => void
}) {
  const [form, setForm] = useState<Provider>(emptyProvider())
  const [presetId, setPresetId] = useState("")
  const [presetModels, setPresetModels] = useState<Model[]>([])
  const [showKey, setShowKey] = useState(false)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(editing ? { ...editing } : cloneDraft ? cloneDraft.provider : emptyProvider())
      setPresetId("")
      setPresetModels(cloneDraft ? cloneDraft.models : [])
      setTouched(false)
      setShowKey(false)
    }
  }, [open, editing, cloneDraft])

  function applyPreset(id: string) {
    const preset = findProviderPreset(id)
    if (!preset) return
    const draft = createProviderPresetDraft(preset, editing || form)
    setPresetId(id)
    setPresetModels(draft.models)
    setForm((current) => ({
      ...draft.provider,
      id: current.id,
      apiKey: current.apiKey,
      isDefault: current.isDefault,
      enabled: current.enabled,
      health: current.health,
      healthMessage: current.healthMessage,
    }))
  }

  const nameError = touched && !form.name.trim() ? "供应商名称不能为空" : undefined
  const urlError =
    touched && !/^https?:\/\/.+/.test(form.baseUrl)
      ? "请输入有效的 Base URL（需以 http(s):// 开头）"
      : undefined
  const keyError = touched && !form.apiKey.trim() ? "该协议需要提供 API Key" : undefined
  const timeoutError =
    touched && (form.timeoutMs < 1000 || form.timeoutMs > 600000)
      ? "超时时间需介于 1000 - 600000 毫秒"
      : undefined
  const bodyOverrideError =
    touched && form.bodyOverride.trim()
      ? (() => {
          try {
            const parsed = JSON.parse(form.bodyOverride)
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? undefined
              : "请求体覆盖必须是 JSON 对象"
          } catch (error) {
            return error instanceof Error
              ? `请求体覆盖不是有效 JSON：${error.message}`
              : "请求体覆盖不是有效 JSON"
          }
        })()
      : undefined

  const valid = !nameError && !urlError && !keyError && !timeoutError && !bodyOverrideError
  const cloneCopy = cloneDraft ? cloneFormCopy(cloneDraft.models.length) : null

  function updateHeader(id: string, patch: Partial<HeaderEntry>) {
    setForm((f) => ({
      ...f,
      headers: f.headers.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    }))
  }

  function handleSubmit() {
    setTouched(true)
    if (
      !form.name.trim() ||
      !/^https?:\/\/.+/.test(form.baseUrl) ||
      !form.apiKey.trim() ||
      form.timeoutMs < 1000 ||
      form.timeoutMs > 600000 ||
      bodyOverrideError
    ) {
      toast.error("请修正表单中的错误后再保存")
      return
    }
    onSubmit(form, editing ? undefined : presetModels)
    onOpenChange(false)
    toast.success(editing ? "供应商已更新" : cloneCopy ? cloneCopy.successToast : "供应商已新增")
  }

  const selectedPreset = presetId ? findProviderPreset(presetId) : undefined

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{editing ? "编辑供应商" : cloneCopy ? cloneCopy.title : "新增供应商"}</SheetTitle>
          <SheetDescription>
            {cloneCopy
              ? cloneCopy.description
              : "协议变更后以新配置为准，转发请求将按当前协议重写。"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4">
          <FieldGroup>
            {!editing && !cloneCopy ? (
              <Field>
                <FieldLabel htmlFor="p-preset">从预设创建</FieldLabel>
                <Select value={presetId} onValueChange={applyPreset}>
                  <SelectTrigger id="p-preset" className="w-full">
                    <SelectValue placeholder="选择供应商预设" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {PROVIDER_PRESETS.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {selectedPreset
                    ? `${selectedPreset.note} 将同时创建 ${selectedPreset.models.length} 个常用模型。`
                    : "预设只填协议、地址、Header 和常用模型，API Key 仍需手动填写。"}
                </FieldDescription>
              </Field>
            ) : null}

            <Field data-invalid={!!nameError}>
              <FieldLabel htmlFor="p-name">供应商名称</FieldLabel>
              <Input
                id="p-name"
                value={form.name}
                aria-invalid={!!nameError}
                placeholder="例如：OpenAI 官方"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
              {nameError ? <FieldError>{nameError}</FieldError> : null}
            </Field>

            <Field>
              <FieldLabel htmlFor="p-protocol">协议类型</FieldLabel>
              <Select
                value={form.protocol}
                onValueChange={(v) => {
                  if (!v) return
                  setForm((f) => ({
                    ...f,
                    protocol: v as ProtocolType,
                    rawResponsesPassthrough:
                      v === "openai-responses" ? f.rawResponsesPassthrough : false,
                  }))
                }}
              >
                <SelectTrigger id="p-protocol" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {PROTOCOLS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PROTOCOL_LABELS[p]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                决定本地中转层如何重写请求体与鉴权头。
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="p-reasoning-dialect">推理方言</FieldLabel>
              <Select
                value={form.reasoningDialect}
                onValueChange={(v) => {
                  if (!v) return
                  setForm((f) => ({ ...f, reasoningDialect: v as ReasoningDialect }))
                }}
              >
                <SelectTrigger id="p-reasoning-dialect" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {REASONING_DIALECTS.map((dialect) => (
                      <SelectItem key={dialect} value={dialect}>
                        {REASONING_DIALECT_LABELS[dialect]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                控制 reasoning 在 OpenAI-compatible 上游里的字段名，例如 DeepSeek 官方、OpenRouter 或 Qwen。
              </FieldDescription>
            </Field>

            <Field orientation="horizontal">
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="p-raw-responses">Responses 原样透传</FieldLabel>
                <FieldDescription>
                  仅 OpenAI Responses 兼容供应商可用；开启后只改 model/reasoning，不改工具、输入或流式响应。
                </FieldDescription>
              </div>
              <Switch
                id="p-raw-responses"
                checked={form.rawResponsesPassthrough}
                disabled={form.protocol !== "openai-responses"}
                onCheckedChange={(value) =>
                  setForm((f) => ({ ...f, rawResponsesPassthrough: value }))
                }
              />
            </Field>

            <Field data-invalid={!!urlError}>
              <FieldLabel htmlFor="p-url">Base URL</FieldLabel>
              <Input
                id="p-url"
                value={form.baseUrl}
                aria-invalid={!!urlError}
                placeholder="https://api.example.com/v1"
                className="font-mono text-sm"
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
              />
              {urlError ? <FieldError>{urlError}</FieldError> : null}
            </Field>

            <Field data-invalid={!!keyError}>
              <FieldLabel htmlFor="p-key">API Key</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="p-key"
                  type={showKey ? "text" : "password"}
                  value={form.apiKey}
                  aria-invalid={!!keyError}
                  placeholder={selectedPreset?.apiKeyPlaceholder || "sk-..."}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton onClick={() => setShowKey((s) => !s)}>
                    {showKey ? "隐藏" : "显示"}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              {keyError ? (
                <FieldError>{keyError}</FieldError>
              ) : (
                <FieldDescription>密钥仅存储在本地，不会上传。</FieldDescription>
              )}
            </Field>

            <Separator />

            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel>自定义 Header</FieldLabel>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      headers: [
                        ...f.headers,
                        { id: `h-${Date.now()}`, key: "", value: "" },
                      ],
                    }))
                  }
                >
                  <Plus data-icon="inline-start" />
                  添加
                </Button>
              </div>
              <div className="flex flex-col gap-2">
                {form.headers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    无自定义 Header，将使用协议默认鉴权头。
                  </p>
                ) : (
                  form.headers.map((h) => (
                    <div key={h.id} className="flex items-center gap-2">
                      <Input
                        value={h.key}
                        placeholder="Header 名"
                        className="font-mono text-xs"
                        onChange={(e) => updateHeader(h.id, { key: e.target.value })}
                      />
                      <Input
                        value={h.value}
                        placeholder="值"
                        className="font-mono text-xs"
                        onChange={(e) => updateHeader(h.id, { value: e.target.value })}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="删除 Header"
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            headers: f.headers.filter((x) => x.id !== h.id),
                          }))
                        }
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </Field>

            <Field data-invalid={!!bodyOverrideError}>
              <FieldLabel htmlFor="p-body-override">请求体覆盖 JSON</FieldLabel>
              <Textarea
                id="p-body-override"
                value={form.bodyOverride}
                aria-invalid={!!bodyOverrideError}
                placeholder={'例如：{"extra_body":{"enable_thinking":true}}'}
                className="min-h-24 font-mono text-xs"
                onChange={(e) =>
                  setForm((f) => ({ ...f, bodyOverride: e.target.value }))
                }
              />
              {bodyOverrideError ? (
                <FieldError>{bodyOverrideError}</FieldError>
              ) : (
                <FieldDescription>
                  转发前深合并到上游请求体；顶层 model 和 stream 会被保护，不允许覆盖。
                </FieldDescription>
              )}
            </Field>

            <Field data-invalid={!!timeoutError}>
              <FieldLabel htmlFor="p-timeout">超时时间（毫秒）</FieldLabel>
              <Input
                id="p-timeout"
                type="number"
                value={form.timeoutMs}
                aria-invalid={!!timeoutError}
                onChange={(e) =>
                  setForm((f) => ({ ...f, timeoutMs: Number(e.target.value) }))
                }
              />
              {timeoutError ? <FieldError>{timeoutError}</FieldError> : null}
            </Field>

            <Field orientation="horizontal">
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="p-enabled">启用该供应商</FieldLabel>
                <FieldDescription>停用后不会出现在热切换选项中。</FieldDescription>
              </div>
              <Switch
                id="p-enabled"
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
            </Field>

            <Field orientation="horizontal">
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor="p-default">设为默认供应商</FieldLabel>
                <FieldDescription>
                  关闭接管时作为透传出口，恢复接管默认配置时也使用。
                </FieldDescription>
              </div>
              <Switch
                id="p-default"
                checked={form.isDefault}
                onCheckedChange={(v) => setForm((f) => ({ ...f, isDefault: v }))}
              />
            </Field>
          </FieldGroup>
        </div>

        <SheetFooter>
          <Button onClick={handleSubmit} disabled={touched && !valid}>
            {editing ? "保存更改" : cloneCopy ? cloneCopy.submitLabel : "新增供应商"}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
