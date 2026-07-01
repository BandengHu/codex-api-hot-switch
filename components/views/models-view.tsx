"use client"

import { useState } from "react"
import {
  ArrowRight,
  Brain,
  Eye,
  ImageIcon,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { MappingFormDialog } from "@/components/models/mapping-form-dialog"
import { ModelFormDialog } from "@/components/models/model-form-dialog"
import { testModel } from "@/lib/console-api"
import { useConsole } from "@/lib/console-store"
import { isChatModel, isImageGenerationModel } from "@/lib/model-capabilities"
import {
  REASONING_DIALECT_LABELS,
  REASONING_DIALECTS,
  REASONING_LABELS,
  type Model,
  type ModelMapping,
  type ModelReasoningDialect,
} from "@/lib/types"
import { toast } from "sonner"

export function ModelsView() {
  const {
    providers,
    models,
    mappings,
    modelsByProvider,
    getProvider,
    getModel,
    updateModel,
    deleteModel,
    updateMapping,
    deleteMapping,
  } = useConsole()
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false)
  const [editingMapping, setEditingMapping] = useState<ModelMapping | null>(null)
  const [deleteMappingTarget, setDeleteMappingTarget] = useState<ModelMapping | null>(null)
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [editingModel, setEditingModel] = useState<Model | null>(null)
  const [modelProviderId, setModelProviderId] = useState<string | undefined>()
  const [deleteModelTarget, setDeleteModelTarget] = useState<Model | null>(null)
  const [testingModelId, setTestingModelId] = useState<string | null>(null)

  const sortedMappings = [...mappings].sort((a, b) => a.priority - b.priority)
  const nextPriority = mappings.length
    ? Math.max(...mappings.map((m) => m.priority)) + 1
    : 1

  function openAddMapping() {
    setEditingMapping(null)
    setMappingDialogOpen(true)
  }

  function openAddModel(providerId?: string) {
    setEditingModel(null)
    setModelProviderId(providerId)
    setModelDialogOpen(true)
  }

  function openEditModel(model: Model) {
    setEditingModel(model)
    setModelProviderId(model.providerId)
    setModelDialogOpen(true)
  }

  async function handleTestModel(providerId: string, model: Model) {
    const provider = getProvider(providerId)
    if (!provider) {
      toast.error("供应商不存在，不能测试模型")
      return
    }
    setTestingModelId(model.id)
    try {
      const result = await testModel({ provider, model, reasoning: "off" })
      if (result.ok) toast.success(result.message)
      else toast.error(result.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setTestingModelId(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">模型管理</h1>
          <p className="text-sm text-muted-foreground">
            按供应商管理模型能力，并配置 Codex 请求的强制映射规则
          </p>
        </div>
        <Button onClick={() => openAddModel()}>
          <Plus data-icon="inline-start" />
          新增模型
        </Button>
      </div>

      {/* 映射规则 */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">强制映射规则</CardTitle>
              <CardDescription>
                按优先级从上到下匹配，命中第一条启用的规则即生效
              </CardDescription>
            </div>
            <Button onClick={openAddMapping}>
              <Plus data-icon="inline-start" />
              新增映射
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16 text-center">优先级</TableHead>
                <TableHead>Codex 请求模型</TableHead>
                <TableHead>映射目标</TableHead>
                <TableHead>reasoning 覆盖</TableHead>
                <TableHead className="text-center">启用</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedMappings.map((m) => {
                const provider = getProvider(m.targetProviderId)
                const model = getModel(m.targetModelId)
                return (
                  <TableRow key={m.id} className={m.enabled ? "" : "opacity-55"}>
                    <TableCell className="text-center">
                      <Badge variant="outline" className="font-mono font-normal">
                        {m.priority}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <code className="font-mono text-sm">{m.codexModel}</code>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-sm">
                        <span className="text-muted-foreground">{provider?.name ?? "—"}</span>
                        <ArrowRight className="size-3.5 text-muted-foreground" />
                        <span className="font-medium">{model?.displayName ?? "—"}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={m.reasoningOverride === "inherit" ? "outline" : "secondary"} className="font-normal">
                        {m.reasoningOverride === "inherit"
                          ? "继承请求"
                          : REASONING_LABELS[m.reasoningOverride]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={m.enabled}
                        onCheckedChange={(v) => updateMapping({ ...m, enabled: v })}
                        aria-label="启用映射"
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="编辑映射"
                          onClick={() => {
                            setEditingMapping(m)
                            setMappingDialogOpen(true)
                          }}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="删除映射"
                          onClick={() => setDeleteMappingTarget(m)}
                        >
                          <Trash2 className="text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 按供应商分组的模型 */}
      {providers.map((provider) => {
        const list = modelsByProvider(provider.id)
        if (list.length === 0) return null
        return (
          <Card key={provider.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">{provider.name}</CardTitle>
                  <CardDescription>{list.length} 个模型</CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openAddModel(provider.id)}
                >
                  <Plus data-icon="inline-start" />
                  添加模型
                </Button>
              </div>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>显示名 / 真实 ID</TableHead>
                    <TableHead>能力</TableHead>
                    <TableHead className="text-right">上下文</TableHead>
                    <TableHead>推理方言</TableHead>
                    <TableHead className="text-center">特性</TableHead>
                    <TableHead className="text-center">启用</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((m) => (
                    <TableRow key={m.id} className={m.enabled ? "" : "opacity-55"}>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium">{m.displayName}</span>
                          <code className="font-mono text-xs text-muted-foreground">
                            {m.modelId}
                          </code>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {m.capabilities.map((c) => (
                            <Badge key={c} variant="secondary" className="font-mono text-[11px] font-normal">
                              {c}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm tabular-nums">
                        {m.contextLength > 0 ? `${(m.contextLength / 1000).toFixed(0)}K` : "-"}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={m.reasoningDialect}
                          onValueChange={(value) =>
                            updateModel({
                              ...m,
                              reasoningDialect: value as ModelReasoningDialect,
                            })
                          }
                        >
                          <SelectTrigger
                            className="h-8 w-[180px]"
                            aria-label="模型推理方言"
                          >
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
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-center gap-2">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <ImageIcon
                                  className={
                                    isImageGenerationModel(m)
                                      ? "size-4 text-foreground"
                                      : "size-4 text-muted-foreground/30"
                                  }
                                />
                              }
                            />
                            <TooltipContent>
                              {isImageGenerationModel(m)
                                ? "支持 image_generation"
                                : "不支持 image_generation"}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Brain
                                  className={
                                    m.supportsReasoning
                                      ? "size-4 text-foreground"
                                      : "size-4 text-muted-foreground/30"
                                  }
                                />
                              }
                            />
                            <TooltipContent>
                              {m.supportsReasoning ? "支持 reasoning" : "不支持 reasoning"}
                            </TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Eye
                                  className={
                                    m.supportsVision
                                      ? "size-4 text-foreground"
                                      : "size-4 text-muted-foreground/30"
                                  }
                                />
                              }
                            />
                            <TooltipContent>
                              {m.supportsVision ? "支持 vision" : "不支持 vision"}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch
                          checked={m.enabled}
                          onCheckedChange={(v) => updateModel({ ...m, enabled: v })}
                          aria-label="启用模型"
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="测试模型"
                            disabled={
                              testingModelId === m.id ||
                              !provider.enabled ||
                              !m.enabled ||
                              !isChatModel(m)
                            }
                            onClick={() => void handleTestModel(provider.id, m)}
                          >
                            {testingModelId === m.id ? (
                              <RefreshCw className="animate-spin" />
                            ) : (
                              <PlugZap />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="编辑模型"
                            onClick={() => openEditModel(m)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="删除模型"
                            onClick={() => setDeleteModelTarget(m)}
                          >
                            <Trash2 className="text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )
      })}

      <MappingFormDialog
        open={mappingDialogOpen}
        onOpenChange={setMappingDialogOpen}
        editing={editingMapping}
        nextPriority={nextPriority}
      />
      <ModelFormDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        editing={editingModel}
        initialProviderId={modelProviderId}
      />

      <AlertDialog
        open={!!deleteMappingTarget}
        onOpenChange={(v) => !v && setDeleteMappingTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除映射规则？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除「{deleteMappingTarget?.codexModel}」的映射规则，删除后接管开启时按当前热切换配置转发。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteMappingTarget) {
                  deleteMapping(deleteMappingTarget.id)
                  toast.success("映射规则已删除")
                  setDeleteMappingTarget(null)
                }
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!deleteModelTarget}
        onOpenChange={(v) => !v && setDeleteModelTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除模型「{deleteModelTarget?.displayName}」？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作会同时删除指向该模型的映射规则；如果当前热切换正在使用它，会自动切到同供应商的其他模型。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteModelTarget) {
                  deleteModel(deleteModelTarget.id)
                  toast.success(`已删除模型「${deleteModelTarget.displayName}」`)
                  setDeleteModelTarget(null)
                }
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
