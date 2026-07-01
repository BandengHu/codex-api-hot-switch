"use client"

import { useEffect, useMemo, useState } from "react"
import { Plus, RotateCcw, Save, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  backupCurrentCodexConfig,
  deleteCodexConfigBackups,
  restoreCodexConfig,
  updateCodexConfigBackupNote,
} from "@/lib/console-api"
import type { CodexConfigStatus } from "@/lib/codex-config-types"
import { toast } from "sonner"

type Working = "create" | "delete" | `restore:${string}` | `note:${string}` | null

interface CodexConfigBackupManagerProps {
  status: CodexConfigStatus
  disabled?: boolean
  onStatus: (status: CodexConfigStatus) => void
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function CodexConfigBackupManager({
  status,
  disabled = false,
  onStatus,
}: CodexConfigBackupManagerProps) {
  const [working, setWorking] = useState<Working>(null)
  const [newNote, setNewNote] = useState("")
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [notes, setNotes] = useState<Record<string, string>>({})

  useEffect(() => {
    setNotes(Object.fromEntries(status.backups.map((backup) => [backup.id, backup.note])))
    setSelected((current) => {
      const available = new Set(status.backups.map((backup) => backup.id))
      return new Set([...current].filter((id) => available.has(id)))
    })
  }, [status.backups])

  const selectedIds = useMemo(() => [...selected], [selected])
  const busy = disabled || Boolean(working)

  function toggleSelected(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  async function run(action: Working, task: () => Promise<void>) {
    setWorking(action)
    try {
      await task()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(null)
    }
  }

  async function handleCreate() {
    await run("create", async () => {
      const result = await backupCurrentCodexConfig(newNote)
      onStatus(result.status)
      setNewNote("")
      toast.success(result.message)
    })
  }

  async function handleRestore(id: string) {
    if (!window.confirm("确定恢复这个备份吗？当前 config.toml 和 auth.json 会被覆盖。")) return
    await run(`restore:${id}`, async () => {
      const result = await restoreCodexConfig(id)
      onStatus(result.status)
      toast.success(result.message)
    })
  }

  async function handleDeleteSelected() {
    if (!selectedIds.length) return
    if (!window.confirm(`确定删除 ${selectedIds.length} 个备份吗？`)) return
    await run("delete", async () => {
      const result = await deleteCodexConfigBackups(selectedIds)
      onStatus(result.status)
      setSelected(new Set())
      toast.success(result.message)
    })
  }

  async function handleSaveNote(id: string) {
    await run(`note:${id}`, async () => {
      const result = await updateCodexConfigBackupNote({
        backupId: id,
        note: notes[id] ?? "",
      })
      onStatus(result.status)
      toast.success(result.message)
    })
  }

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">配置备份</div>
          <div className="text-xs text-muted-foreground">备份包含 config.toml 和 auth.json</div>
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => void handleDeleteSelected()}
          disabled={busy || selectedIds.length === 0}
        >
          {working === "delete" ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
          删除选中
        </Button>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          value={newNote}
          onChange={(event) => setNewNote(event.target.value)}
          placeholder="新备份备注，可留空"
          disabled={busy}
        />
        <Button onClick={() => void handleCreate()} disabled={busy || !status.configExists}>
          {working === "create" ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
          当前配置设为备份
        </Button>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {status.backups.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
            暂无备份
          </div>
        ) : (
          status.backups.map((backup) => (
            <div key={backup.id} className="rounded-md border bg-background p-3">
              <div className="flex flex-wrap items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 accent-primary"
                  checked={selected.has(backup.id)}
                  onChange={(event) => toggleSelected(backup.id, event.target.checked)}
                  disabled={busy}
                  aria-label="选择备份"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{backup.id}</span>
                    <Badge variant="secondary">config</Badge>
                    <Badge variant={backup.hasAuth ? "secondary" : "outline"}>
                      auth {backup.hasAuth ? "已备份" : "无"}
                    </Badge>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{formatTime(backup.createdAt)}</div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleRestore(backup.id)}
                  disabled={busy}
                >
                  {working === `restore:${backup.id}` ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RotateCcw data-icon="inline-start" />
                  )}
                  恢复
                </Button>
              </div>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input
                  value={notes[backup.id] ?? ""}
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [backup.id]: event.target.value }))
                  }
                  placeholder="备注"
                  disabled={busy}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleSaveNote(backup.id)}
                  disabled={busy || (notes[backup.id] ?? "") === backup.note}
                >
                  {working === `note:${backup.id}` ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <Save data-icon="inline-start" />
                  )}
                  保存备注
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
