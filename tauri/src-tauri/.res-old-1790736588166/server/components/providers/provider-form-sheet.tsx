"use client"

import { useEffect, useMemo, useState } from "react"
import { ListChecks, Plus, RefreshCw, Trash2 } from "lucide-react"
import { ProviderModelDiscoveryDialog } from "@/components/providers/provider-model-discovery-dialog"
import { ProviderEndpointEditor } from "@/components/providers/provider-endpoint-editor"
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
import { Separator } from "@/components/ui/separator"
import {
  PROTOCOL_LABELS,
  REASONING_DIALECT_LABELS,
  REASONING_DIALECTS,
  type Provider,
  type ProtocolType,
  type HeaderEntry,
  type Model,
  type PromptCacheRouting,
  type ReasoningDialect,
} from "@/lib/types"
import {
  PROVIDER_PRESETS,
  createProviderPresetDraft,
  findProviderPreset,
} from "@/lib/provider-presets"
import { cloneFormCopy, type ProviderCloneDraft } from "@/lib/provider-clone"
import { createProviderEndpoint } from "@/lib/provider-endpoints"
import { useConsole } from "@/lib/console-store"
import {
  buildImportedModelDrafts,
  type DiscoveredModel,
} from "@/lib/provider-model-discovery"
import { fetchProviderModels } from "@/lib/console-api"
import { toast } from "sonner"

const PROTOCOLS: ProtocolType[] = [
  "openai-responses",
  "openai-chat",
  "anthropic",
  "gemini",
]

function emptyProvider(): Provider {
  const id = `prov-${Date.now()}`
  return {
    id,
    name: "",
    protocol: "openai-responses",
    endpoints: [
      createProviderEndpoint(id, {
        id: `${id}-primary`,
        name: "主用",
        enabled: true,
      }),
    ],
    headers: [],
    bodyOverride: "",
    timeoutMs: 60000,
    reasoningDialect: "auto",
    promptCacheRouting: "auto",
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
  existingModels = [],
  onSubmit,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editing: Provider | null
  cloneDraft?: ProviderCloneDraft | null
  existingModels?: Model[]
  onSubmit: (p: Provider, models?: Model[]) => void
}) {
  const [form, setForm] = useState<Provider>(emptyProvider())
  const { endpointStates, resetProviderEndpoint } = useConsole()
  const [presetId, setPresetId] = useState("")
  const [presetModels, setPresetModels] = useState<Model[]>([])
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([])
  const [importedModels, setImportedModels] = useState<Model[]>([])
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const [discoveryLoading, setDiscoveryLoading] = useState(false)
  const [discoveryEndpointName, setDiscoveryEndpointName] = useState("")
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(editing ? { ...editing } : cloneDraft ? cloneDraft.provider : emptyProvider())
      setPresetId("")
      setPresetModels(cloneDraft ? cloneDraft.models : [])
      setDiscoveredModels([])
      setImportedModels([])
      setDiscoveryOpen(false)
      setDiscoveryEndpointName("")
      setTouched(false)
    }
  }, [open, editing, cloneDraft])

  function applyPreset(id: string) {
    const preset = findProviderPreset(id)
    if (!preset) return
    const draft = createProviderPresetDraft(preset, editing || form)
    setPresetId(id)
    setPresetModels(draft.models)
    setDiscoveredModels([])
    setImportedModels([])
    setDiscoveryOpen(false)
    setDiscoveryEndpointName("")
    setForm((current) => ({
      ...draft.provider,
      id: current.id,
      isDefault: current.isDefault,
      enabled: current.enabled,
      health: current.health,
      healthMessage: current.healthMessage,
    }))
  }

  const nameError = touched && !form.name.trim() ? "供应商名称不能为空" : undefined
  const endpointError =
    touched &&
    (
      form.endpoints.length === 0 ||
      !form.endpoints.some((endpoint) => endpoint.enabled) ||
      form.endpoints.some((endpoint, index) => {
        const url = endpoint.baseUrl.trim()
        return (
          !endpoint.name.trim() ||
          ((index === 0 || url) && !/^https?:\/\/.+/.test(url)) ||
          (endpoint.enabled && !endpoint.apiKey.trim())
        )
      })
    )
      ? "请至少启用一个端点，并修正端点名称、URL 和 API Key"
      : undefined
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

  const valid = !nameError && !endpointError && !timeoutError && !bodyOverrideError
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
      Boolean(endpointError) ||
      form.timeoutMs < 1000 ||
      form.timeoutMs > 600000 ||
      bodyOverrideError
    ) {
      toast.error("请修正表单中的错误后再保存")
      return
    }
    const nextModels = editing ? importedModels : [...presetModels, ...importedModels]
    onSubmit(form, nextModels.length > 0 ? nextModels : undefined)
    onOpenChange(false)
    toast.success(editing ? "供应商已更新" : cloneCopy ? cloneCopy.successToast : "供应商已新增")
  }

  const selectedPreset = presetId ? findProviderPreset(presetId) : undefined
  async function handleDiscoverModels() {
    setDiscoveryLoading(true)
    try {
      const result = await fetchProviderModels(form)
      setDiscoveredModels(result.models)
      setDiscoveryEndpointName(result.endpointName)
      setDiscoveryOpen(true)
      if (result.models.length === 0) {
        toast.warning("主用端点返回了空模型列表")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDiscoveryLoading(false)
    }
  }

  function handleImportModels(models: DiscoveredModel[]) {
    const nextImportedModels = buildImportedModelDrafts(
      form.id,
      models,
      models.map((model) => model.id),
      [...existingModels, ...presetModels],
    )
    setImportedModels(nextImportedModels)
    toast.success(`已选择 ${models.length} 个模型，保存供应商时写入`)
  }

  const discoveryExistingModelIds = useMemo(
    () => [
      ...existingModels.map((model) => model.modelId),
      ...presetModels.map((model) => model.modelId),
      ...importedModels.map((model) => model.modelId),
    ],
    [existingModels, importedModels, presetModels],
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-2xl">
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

            {form.protocol === "openai-chat" ? (
              <Field>
                <FieldLabel htmlFor="p-prompt-cache-routing">
                  Prompt Cache 会话路由
                </FieldLabel>
                <Select
                  value={form.promptCacheRouting || "auto"}
                  onValueChange={(value) => {
                    if (!value) return
                    setForm((current) => ({
                      ...current,
                      promptCacheRouting: value as PromptCacheRouting,
                    }))
                  }}
                >
                  <SelectTrigger id="p-prompt-cache-routing" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="auto">自动</SelectItem>
                      <SelectItem value="enabled">开启</SelectItem>
                      <SelectItem value="disabled">关闭</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  自动模式仅对 OpenAI 官方和 Kimi Coding 发送客户端提供的 prompt_cache_key；严格网关可保持关闭。
                </FieldDescription>
              </Field>
            ) : null}

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

            <ProviderEndpointEditor
              providerId={form.id}
              endpoints={form.endpoints}
              runtimeStates={endpointStates}
              touched={touched}
              onChange={(endpoints) => setForm((current) => ({ ...current, endpoints }))}
              onReset={async (endpointId) => {
                await resetProviderEndpoint(form.id, endpointId)
                toast.success("端点失败、冷却和停用状态已清除")
              }}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <ListChecks className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">从主用端点获取模型</div>
                  <div className="text-xs text-muted-foreground">
                    只读取第一组 URL/API Key，不会尝试备用端点
                  </div>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={discoveryLoading}
                onClick={() => void handleDiscoverModels()}
              >
                {discoveryLoading ? (
                  <RefreshCw className="animate-spin" data-icon="inline-start" />
                ) : (
                  <ListChecks data-icon="inline-start" />
                )}
                获取模型
              </Button>
            </div>
            {endpointError ? <FieldError>{endpointError}</FieldError> : null}

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
      <ProviderModelDiscoveryDialog
        open={discoveryOpen}
        onOpenChange={setDiscoveryOpen}
        endpointName={discoveryEndpointName}
        models={discoveredModels}
        existingModelIds={discoveryExistingModelIds}
        onConfirm={handleImportModels}
      />
    </Sheet>
  )
}
