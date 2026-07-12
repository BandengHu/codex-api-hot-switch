"use client"

import { useState } from "react"
import { Plus, Pencil, Trash2, AlertTriangle, Copy } from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { HealthBadge, ProtocolBadge } from "@/components/status-badges"
import { ProviderFormSheet } from "@/components/providers/provider-form-sheet"
import { useConsole } from "@/lib/console-store"
import {
  REASONING_DIALECT_LABELS,
  type Provider,
} from "@/lib/types"
import {
  dismissProviderSheetState,
  openCloneSheetState,
  type ProviderCloneDraft,
} from "@/lib/provider-clone"
import { toast } from "sonner"

export function ProvidersView() {
  const { providers, modelsByProvider, addProvider, addProviderWithModels, updateProvider, deleteProvider } =
    useConsole()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [cloneDraft, setCloneDraft] = useState<ProviderCloneDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null)

  const unhealthy = providers.filter((p) => p.health !== "healthy" && p.enabled)

  function openAdd() {
    setEditing(null)
    setCloneDraft(null)
    setSheetOpen(true)
  }
  function openEdit(p: Provider) {
    setEditing(p)
    setCloneDraft(null)
    setSheetOpen(true)
  }
  function openClone(p: Provider) {
    const next = openCloneSheetState(p, modelsByProvider(p.id))
    setEditing(next.editing)
    setCloneDraft(next.cloneDraft)
    setSheetOpen(next.sheetOpen)
  }

  function handleSheetOpenChange(open: boolean) {
    if (open) {
      setSheetOpen(true)
      return
    }
    const dismissed = dismissProviderSheetState()
    setSheetOpen(dismissed.sheetOpen)
    setEditing(dismissed.editing)
    setCloneDraft(dismissed.cloneDraft)
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">供应商管理</h1>
          <p className="text-sm text-muted-foreground">
            管理上游供应商的协议、地址、密钥与健康状态
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus data-icon="inline-start" />
          新增供应商
        </Button>
      </div>

      {unhealthy.length > 0 ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{unhealthy.length} 个供应商存在健康问题</AlertTitle>
          <AlertDescription>
            {unhealthy.map((p) => p.name).join("、")} 当前不可用或处于降级状态，切换前请确认。
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">供应商列表</CardTitle>
          <CardDescription>共 {providers.length} 个供应商</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>协议</TableHead>
                <TableHead>推理方言</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead className="text-center">模型数</TableHead>
                <TableHead>健康状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.name}</span>
                      {p.isDefault ? (
                        <Badge variant="secondary" className="font-normal">
                          默认
                        </Badge>
                      ) : null}
                      {!p.enabled ? (
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          已停用
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <ProtocolBadge protocol={p.protocol} />
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-normal">
                      {REASONING_DIALECT_LABELS[p.reasoningDialect]}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[220px]">
                    <code className="block truncate font-mono text-xs text-muted-foreground">
                      {p.baseUrl}
                    </code>
                  </TableCell>
                  <TableCell className="text-center font-mono text-sm tabular-nums">
                    {modelsByProvider(p.id).length}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <HealthBadge status={p.health} />
                      {p.healthMessage ? (
                        <span className="max-w-[200px] truncate text-xs text-destructive">
                          {p.healthMessage}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="复制供应商"
                        onClick={() => openClone(p)}
                      >
                        <Copy />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="编辑"
                        onClick={() => openEdit(p)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="删除"
                        onClick={() => setDeleteTarget(p)}
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

      <ProviderFormSheet
        open={sheetOpen}
        onOpenChange={handleSheetOpenChange}
        editing={editing}
        cloneDraft={cloneDraft}
        onSubmit={(p, models) =>
          editing
            ? updateProvider(p)
            : models?.length
              ? addProviderWithModels(p, models)
              : addProvider(p)
        }
      />

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除供应商「{deleteTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作将同时删除该供应商下的所有模型与相关映射，且无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) {
                  deleteProvider(deleteTarget.id)
                  toast.success(`已删除供应商「${deleteTarget.name}」`)
                  setDeleteTarget(null)
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
