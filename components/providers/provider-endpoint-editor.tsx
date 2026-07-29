"use client"

import { useState } from "react"
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { createProviderEndpoint } from "@/lib/provider-endpoints"
import type {
  ProviderEndpoint,
  ProviderEndpointRuntimeState,
} from "@/lib/types"

function endpointStatus(state: ProviderEndpointRuntimeState | undefined) {
  if (!state) return { label: "可用", variant: "outline" as const }
  if (state.quotaDisabled) {
    return { label: "额度停用", variant: "destructive" as const }
  }
  if (state.authDisabled) {
    return { label: "Key 失效", variant: "destructive" as const }
  }
  if (state.cooldownUntil && Date.parse(state.cooldownUntil) > Date.now()) {
    return {
      label: `冷却至 ${new Date(state.cooldownUntil).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })}`,
      variant: "secondary" as const,
    }
  }
  if (state.consecutiveFailures > 0) {
    return {
      label: `连续失败 ${state.consecutiveFailures}/4`,
      variant: "secondary" as const,
    }
  }
  return { label: "可用", variant: "outline" as const }
}

function endpointErrors(endpoint: ProviderEndpoint, index: number, touched: boolean) {
  if (!touched) return {}
  const url = endpoint.baseUrl.trim()
  return {
    name: !endpoint.name.trim() ? "端点名称不能为空" : undefined,
    baseUrl:
      (index === 0 || url) && !/^https?:\/\/.+/.test(url)
        ? index === 0
          ? "主用 URL 必须以 http(s):// 开头"
          : "备用 URL 必须以 http(s):// 开头，或留空继承主用 URL"
        : undefined,
    apiKey:
      endpoint.enabled && !endpoint.apiKey.trim()
        ? "启用的端点必须提供 API Key"
        : undefined,
  }
}

export function ProviderEndpointEditor({
  providerId,
  endpoints,
  runtimeStates,
  touched,
  onChange,
  onReset,
}: {
  providerId: string
  endpoints: ProviderEndpoint[]
  runtimeStates: ProviderEndpointRuntimeState[]
  touched: boolean
  onChange: (endpoints: ProviderEndpoint[]) => void
  onReset: (endpointId: string) => Promise<void>
}) {
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => new Set())
  const stateById = new Map(
    runtimeStates
      .filter((state) => state.providerId === providerId)
      .map((state) => [state.endpointId, state]),
  )
  const primaryUrl = endpoints[0]?.baseUrl.trim() || ""

  function updateEndpoint(id: string, patch: Partial<ProviderEndpoint>) {
    onChange(
      endpoints.map((endpoint) =>
        endpoint.id === id ? { ...endpoint, ...patch } : endpoint,
      ),
    )
  }

  function moveEndpoint(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= endpoints.length) return
    const next = [...endpoints]
    const [endpoint] = next.splice(index, 1)
    next.splice(target, 0, endpoint)
    onChange(next)
  }

  function addEndpoint() {
    onChange([
      ...endpoints,
      createProviderEndpoint(providerId, {
        name: `备用 ${endpoints.length}`,
        enabled: true,
      }),
    ])
  }

  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <div>
          <FieldLabel>URL / API Key 端点组</FieldLabel>
          <FieldDescription>
            按顺序使用；备用 URL 留空时继承主用 URL，可为同一地址配置不同 Key。
          </FieldDescription>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addEndpoint}>
          <Plus data-icon="inline-start" />
          添加备用
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {endpoints.map((endpoint, index) => {
          const state = stateById.get(endpoint.id)
          const status = endpointStatus(state)
          const errors = endpointErrors(endpoint, index, touched)
          const keyVisible = visibleKeys.has(endpoint.id)
          const canReset = Boolean(
            state &&
              (state.quotaDisabled ||
                state.authDisabled ||
                state.cooldownUntil ||
                state.consecutiveFailures > 0),
          )
          return (
            <div
              key={endpoint.id}
              className="flex flex-col gap-3 rounded-md border border-border p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant={index === 0 ? "default" : "outline"}>
                    {index === 0 ? "主用" : `备用 ${index}`}
                  </Badge>
                  <Badge variant={status.variant}>{status.label}</Badge>
                  {!endpoint.enabled ? <Badge variant="outline">手动关闭</Badge> : null}
                </div>
                <div className="flex items-center gap-1">
                  {canReset ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      title="清除失败、冷却和停用状态"
                      onClick={() => void onReset(endpoint.id)}
                    >
                      <RotateCcw />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="上移"
                    disabled={index === 0}
                    onClick={() => moveEndpoint(index, -1)}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="下移"
                    disabled={index === endpoints.length - 1}
                    onClick={() => moveEndpoint(index, 1)}
                  >
                    <ChevronDown />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="删除端点"
                    disabled={endpoints.length === 1}
                    onClick={() =>
                      onChange(endpoints.filter((value) => value.id !== endpoint.id))
                    }
                  >
                    <Trash2 className="text-destructive" />
                  </Button>
                  <Switch
                    checked={endpoint.enabled}
                    aria-label={`${endpoint.name}启用状态`}
                    onCheckedChange={(enabled) => updateEndpoint(endpoint.id, { enabled })}
                  />
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-[minmax(120px,0.7fr)_minmax(0,1.6fr)]">
                <Field data-invalid={Boolean(errors.name)}>
                  <FieldLabel htmlFor={`${endpoint.id}-name`}>名称</FieldLabel>
                  <Input
                    id={`${endpoint.id}-name`}
                    value={endpoint.name}
                    aria-invalid={Boolean(errors.name)}
                    onChange={(event) =>
                      updateEndpoint(endpoint.id, { name: event.target.value })
                    }
                  />
                  {errors.name ? <FieldError>{errors.name}</FieldError> : null}
                </Field>
                <Field data-invalid={Boolean(errors.baseUrl)}>
                  <FieldLabel htmlFor={`${endpoint.id}-url`}>Base URL</FieldLabel>
                  <Input
                    id={`${endpoint.id}-url`}
                    value={endpoint.baseUrl}
                    aria-invalid={Boolean(errors.baseUrl)}
                    className="font-mono text-sm"
                    placeholder={
                      index === 0
                        ? "https://api.example.com/v1"
                        : primaryUrl
                          ? `留空继承 ${primaryUrl}`
                          : "留空继承主用 URL"
                    }
                    onChange={(event) =>
                      updateEndpoint(endpoint.id, { baseUrl: event.target.value })
                    }
                  />
                  {errors.baseUrl ? <FieldError>{errors.baseUrl}</FieldError> : null}
                </Field>
              </div>

              <Field data-invalid={Boolean(errors.apiKey)}>
                <FieldLabel htmlFor={`${endpoint.id}-key`}>API Key</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id={`${endpoint.id}-key`}
                    type={keyVisible ? "text" : "password"}
                    value={endpoint.apiKey}
                    aria-invalid={Boolean(errors.apiKey)}
                    className="font-mono text-sm"
                    placeholder="sk-..."
                    onChange={(event) =>
                      updateEndpoint(endpoint.id, { apiKey: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    title={keyVisible ? "隐藏 API Key" : "显示 API Key"}
                    onClick={() =>
                      setVisibleKeys((current) => {
                        const next = new Set(current)
                        if (next.has(endpoint.id)) next.delete(endpoint.id)
                        else next.add(endpoint.id)
                        return next
                      })
                    }
                  >
                    {keyVisible ? <EyeOff /> : <Eye />}
                  </Button>
                </div>
                {errors.apiKey ? <FieldError>{errors.apiKey}</FieldError> : null}
              </Field>

              {state?.lastError ? (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  最近错误：{state.lastError}
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
    </Field>
  )
}
