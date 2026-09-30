"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, ListChecks, RefreshCw, Search } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  defaultSelectedDiscoveredModelIds,
  normalizeModelId,
  type DiscoveredModel,
} from "@/lib/provider-model-discovery"

export function ProviderModelDiscoveryDialog({
  open,
  onOpenChange,
  endpointName,
  models,
  existingModelIds,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  endpointName: string
  models: DiscoveredModel[]
  existingModelIds: string[]
  onConfirm: (models: DiscoveredModel[]) => void
}) {
  const [query, setQuery] = useState("")
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setSelectedIds(defaultSelectedDiscoveredModelIds(models, existingModelIds))
    setQuery("")
  }, [existingModelIds, models, open])

  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return models
    return models.filter((model) =>
      `${model.displayName} ${model.id} ${model.ownedBy || ""}`
        .toLowerCase()
        .includes(normalizedQuery),
    )
  }, [models, query])

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const allVisibleSelected =
    filteredModels.length > 0 && filteredModels.every((model) => selectedSet.has(model.id))

  function toggleModel(id: string) {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    )
  }

  function toggleVisible() {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const model of filteredModels) {
        if (allVisibleSelected) next.delete(model.id)
        else next.add(model.id)
      }
      return Array.from(next)
    })
  }

  function handleConfirm() {
    const selected = new Set(selectedIds)
    onConfirm(models.filter((model) => selected.has(model.id)))
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="size-5" />
            选择供应商模型
          </DialogTitle>
          <DialogDescription>
            来源：{endpointName || "主用端点"}。新供应商默认不勾选，已有模型会默认勾选；模型能力和上下文长度仍可在导入后修改。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-8"
              placeholder="搜索模型名称或 ID"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={filteredModels.length === 0}
            onClick={toggleVisible}
          >
            {allVisibleSelected ? "取消全选" : "全选当前"}
          </Button>
          <Badge variant="secondary">{selectedIds.length} 已选</Badge>
        </div>

        <div className="min-h-0 overflow-y-auto rounded-lg border border-border">
          {models.length === 0 ? (
            <div className="flex h-40 items-center justify-center px-4 text-sm text-muted-foreground">
              上游没有返回可识别的模型
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="flex h-40 items-center justify-center px-4 text-sm text-muted-foreground">
              没有匹配的模型
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredModels.map((model) => {
                const selected = selectedSet.has(model.id)
                const existing = existingModelIds.some(
                  (id) => normalizeModelId(id) === normalizeModelId(model.id),
                )
                return (
                  <label
                    key={model.id}
                    className="flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleModel(model.id)}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{model.displayName}</span>
                        {existing ? (
                          <Badge variant="outline" className="gap-1 font-normal">
                            <Check className="size-3" />
                            已添加
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">
                        {model.id}
                      </span>
                      <span className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        {model.contextLength ? `${Math.round(model.contextLength / 1000)}K 上下文` : null}
                        {model.supportsTools ? "工具" : null}
                        {model.supportsReasoning ? "推理" : null}
                        {model.supportsVision ? "视觉" : null}
                        {model.ownedBy ? `归属：${model.ownedBy}` : null}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>

        <Separator />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={selectedIds.length === 0}>
            <RefreshCw data-icon="inline-start" />
            导入选中 {selectedIds.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
