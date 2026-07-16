"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Database,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  Trash2,
  Waypoints,
} from "lucide-react"
import {
  clearCodexSessionBackups,
  deleteCodexSessions,
  fetchCodexSessionSyncStatus,
  syncCodexSessions,
} from "@/lib/console-api"
import type {
  CodexSessionItem,
  CodexSessionSyncStatus,
} from "@/lib/codex-session-types"
import { formatTokenCount } from "@/lib/display-format"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  buildCodexSessionGroups,
  filterCodexSessionGroups,
  type CodexSessionProjectGroup,
} from "./codex-sessions/session-groups"

function formatDate(value: number) {
  if (!value) return "-"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

function formatSessionId(id: string) {
  return id.length <= 18 ? id : `${id.slice(0, 8)}...${id.slice(-6)}`
}

function providerCountText(counts: Record<string, number>) {
  const entries = Object.entries(counts || {})
  if (entries.length === 0) return "-"
  return entries.map(([provider, count]) => `${provider} ${count}`).join(" / ")
}

function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  label: string
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(node) => {
        if (node) node.indeterminate = Boolean(indeterminate)
      }}
      onChange={onChange}
      className="size-4 rounded border-border accent-primary"
    />
  )
}

function ProjectTreeRow({
  group,
  active,
  expanded,
  selectedCount,
  selectedIdSet,
  onToggleExpanded,
  onSelect,
  onToggleSession,
  onOpen,
}: {
  group: CodexSessionProjectGroup
  active: boolean
  expanded: boolean
  selectedCount: number
  selectedIdSet: Set<string>
  onToggleExpanded: () => void
  onSelect: () => void
  onToggleSession: (id: string) => void
  onOpen: () => void
}) {
  const allSelected = selectedCount === group.sessions.length && group.sessions.length > 0
  const partlySelected = selectedCount > 0 && !allSelected

  return (
    <div
      className={cn(
        "rounded-lg border border-transparent bg-background/60",
        active ? "border-primary/30 bg-primary/10" : "hover:bg-muted/50",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 px-2 py-2">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={expanded ? "收起项目" : "展开项目"}
          onClick={onToggleExpanded}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </Button>
        <Checkbox
          checked={allSelected}
          indeterminate={partlySelected}
          label={`选择项目 ${group.label}`}
          onChange={onSelect}
        />
        <button
          type="button"
          onClick={onOpen}
          title={group.cwd}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {expanded ? (
            <FolderOpen className="size-4 shrink-0 text-amber-500" />
          ) : (
            <Folder className="size-4 shrink-0 text-amber-500" />
          )}
          <span className="truncate text-sm font-medium">{group.label}</span>
        </button>
        <Badge variant="secondary" className="shrink-0">
          {group.sessions.length}
        </Badge>
      </div>
      {expanded ? (
        <div className="space-y-1 border-t border-border/60 px-2 py-2">
          {group.sessions.map((session) => (
            <div
              key={session.id}
              className="grid grid-cols-[16px_minmax(0,1fr)] items-center gap-2 rounded-md px-8 py-1 hover:bg-background"
            >
              <Checkbox
                checked={selectedIdSet.has(session.id)}
                label={`树中选择会话 ${session.title}`}
                onChange={() => onToggleSession(session.id)}
              />
              <button
                type="button"
                title={session.title}
                onClick={onOpen}
                className="truncate text-left text-xs text-muted-foreground"
              >
                {session.title || "未命名会话"}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function SessionListRow({
  session,
  selected,
  onToggle,
}: {
  session: CodexSessionItem
  selected: boolean
  onToggle: () => void
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1.8fr)_minmax(160px,0.8fr)_120px] items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0">
      <Checkbox checked={selected} label={`列表选择会话 ${session.title}`} onChange={onToggle} />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium" title={session.title}>
            {session.title || "未命名会话"}
          </span>
          {session.archived ? (
            <Badge variant="outline" className="shrink-0">
              归档
            </Badge>
          ) : null}
          {session.duplicateSourceCount > 1 ? (
            <Badge variant="secondary" className="shrink-0">
              {session.duplicateSourceCount} 源
            </Badge>
          ) : null}
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span title={session.id}>ID: {formatSessionId(session.id)}</span>
          <span>{session.sourceDbSource === "sqlite-dir" ? "sqlite" : "legacy"}</span>
          {session.tokensUsed > 0 ? <span>{formatTokenCount(session.tokensUsed)}</span> : null}
        </div>
      </div>
      <div className="min-w-0 text-xs">
        <div className="truncate">{session.modelProvider || "-"}</div>
        <div className="truncate text-muted-foreground">{session.model || "-"}</div>
      </div>
      <div className="text-right text-xs text-muted-foreground">{formatDate(session.updatedAtMs)}</div>
    </div>
  )
}

export function CodexSessionsView() {
  const [status, setStatus] = useState<CodexSessionSyncStatus | null>(null)
  const [query, setQuery] = useState("")
  const [activeCwd, setActiveCwd] = useState("")
  const [expandedCwds, setExpandedCwds] = useState<string[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [clearBackupsOpen, setClearBackupsOpen] = useState(false)

  async function refresh() {
    setLoading(true)
    setError("")
    try {
      const nextStatus = await fetchCodexSessionSyncStatus()
      setStatus(nextStatus)
      setSelectedIds((current) =>
        current.filter((id) => nextStatus.sessions.some((session) => session.id === id)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const groups = useMemo(
    () => buildCodexSessionGroups(status?.sessions || []),
    [status?.sessions],
  )
  const visibleGroups = useMemo(
    () => filterCodexSessionGroups(groups, query),
    [groups, query],
  )
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const activeGroup = useMemo(() => {
    if (visibleGroups.length === 0) return null
    return visibleGroups.find((group) => group.cwd === activeCwd) || visibleGroups[0]
  }, [activeCwd, visibleGroups])
  const allVisibleSessionIds = useMemo(
    () => visibleGroups.flatMap((group) => group.sessions.map((session) => session.id)),
    [visibleGroups],
  )

  useEffect(() => {
    if (!activeGroup) return
    setActiveCwd(activeGroup.cwd)
  }, [activeGroup])

  useEffect(() => {
    if (expandedCwds.length > 0 || groups.length === 0) return
    setExpandedCwds([groups[0].cwd])
  }, [expandedCwds.length, groups])

  async function handleSync() {
    setWorking(true)
    setError("")
    setMessage("")
    try {
      const result = await syncCodexSessions()
      setStatus(result.status)
      setMessage(result.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  async function confirmDelete() {
    if (selectedIds.length === 0) return
    setWorking(true)
    setError("")
    setMessage("")
    try {
      const result = await deleteCodexSessions(selectedIds)
      setStatus(result.status)
      setSelectedIds([])
      setDeleteOpen(false)
      setMessage(result.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  async function confirmClearBackups() {
    setWorking(true)
    setError("")
    setMessage("")
    try {
      const result = await clearCodexSessionBackups()
      setStatus(result.status)
      setMessage(result.message)
      setClearBackupsOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  function toggleExpanded(cwd: string) {
    setExpandedCwds((current) =>
      current.includes(cwd) ? current.filter((item) => item !== cwd) : [...current, cwd],
    )
  }

  function toggleSession(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }

  function toggleGroupSelection(group: CodexSessionProjectGroup) {
    const ids = group.sessions.map((session) => session.id)
    const allSelected = ids.every((id) => selectedIdSet.has(id))
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return Array.from(next)
    })
  }

  function toggleAllVisible() {
    const allSelected = allVisibleSessionIds.every((id) => selectedIdSet.has(id))
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const id of allVisibleSessionIds) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return Array.from(next)
    })
  }

  const databases = status?.databases || []
  const activeDbCount = databases.filter((item) => item.exists).length
  const allVisibleSelected =
    allVisibleSessionIds.length > 0 && allVisibleSessionIds.every((id) => selectedIdSet.has(id))
  const partlyVisibleSelected =
    allVisibleSessionIds.some((id) => selectedIdSet.has(id)) && !allVisibleSelected

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Waypoints className="size-5" />
            同步会话
          </h1>
          <p className="text-sm text-muted-foreground">
            按项目管理 Codex 本地会话，同 ID 保留最新版本，删除前会自动备份
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={refresh} disabled={loading || working}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
          <Button onClick={handleSync} disabled={loading || working}>
            <Waypoints className="size-4" />
            立即同步
          </Button>
          <Button
            variant="destructive"
            disabled={loading || working || selectedIds.length === 0}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="size-4" />
            删除选中 {selectedIds.length}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {message}
        </div>
      ) : null}
      {status?.encryptedContentWarning ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          {status.encryptedContentWarning}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>会话总数</CardDescription>
            <CardTitle>{loading ? "-" : status?.totalSessions ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>项目数</CardDescription>
            <CardTitle>{loading ? "-" : groups.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>状态库</CardDescription>
            <CardTitle>{activeDbCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <CardDescription>备份</CardDescription>
                <CardTitle className="text-base">
                  {status ? `${status.backupCount} / ${formatBytes(status.backupBytes)}` : "-"}
                </CardTitle>
              </div>
              <Button
                variant="destructive"
                size="xs"
                disabled={loading || working || !status || status.backupCount === 0}
                onClick={() => setClearBackupsOpen(true)}
              >
                清空
              </Button>
            </div>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="size-4" />
                同步范围
              </CardTitle>
              <CardDescription>
                当前主库：{status?.canonicalDbPath || "未找到"}
              </CardDescription>
            </div>
            <Badge variant="outline">
              rollout {providerCountText(status?.rolloutCounts.sessions || {})}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {databases.map((database) => (
            <div
              key={database.path}
              className="rounded-lg border border-border bg-muted/20 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {database.source === "sqlite-dir" ? "新版 sqlite 目录" : "旧版根目录"}
                </span>
                <Badge variant={database.exists ? "secondary" : "outline"}>
                  {database.exists ? `${database.threadCount} 条` : "不存在"}
                </Badge>
              </div>
              <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
                {database.path}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                最近更新：{formatDate(database.updatedAtMs)}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Archive className="size-4" />
                会话管理
              </CardTitle>
              <CardDescription>按项目树形分组，显示 Codex 会话标题</CardDescription>
            </div>
            <div className="relative w-full sm:w-80">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8"
                placeholder="搜索项目、标题、模型"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid min-h-[460px] gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col rounded-lg border border-border bg-muted/20">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={partlyVisibleSelected}
                    label="选择当前筛选结果"
                    onChange={toggleAllVisible}
                  />
                  <span className="text-sm font-medium">项目树</span>
                </div>
                <span className="text-xs text-muted-foreground">{visibleGroups.length} 个项目</span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
                {!loading && visibleGroups.length === 0 ? (
                  <div className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Folder className="size-8" />
                    暂无会话
                  </div>
                ) : null}
                {visibleGroups.map((group) => (
                  <ProjectTreeRow
                    key={group.cwd}
                    group={group}
                    active={activeGroup?.cwd === group.cwd}
                    expanded={expandedCwds.includes(group.cwd)}
                    selectedCount={group.sessions.filter((session) => selectedIdSet.has(session.id)).length}
                    selectedIdSet={selectedIdSet}
                    onToggleExpanded={() => toggleExpanded(group.cwd)}
                    onSelect={() => toggleGroupSelection(group)}
                    onToggleSession={toggleSession}
                    onOpen={() => {
                      setActiveCwd(group.cwd)
                      if (!expandedCwds.includes(group.cwd)) {
                        setExpandedCwds((current) => [...current, group.cwd])
                      }
                    }}
                  />
                ))}
              </div>
            </div>

            <div className="flex min-w-0 flex-col rounded-lg border border-border">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <FolderOpen className="size-4 shrink-0 text-amber-500" />
                    <h2 className="truncate text-sm font-semibold">
                      {activeGroup?.label || "未选择项目"}
                    </h2>
                  </div>
                  <div className="mt-1 break-all text-xs text-muted-foreground">
                    {activeGroup?.cwd || "没有匹配的会话"}
                  </div>
                </div>
                <Badge variant="secondary">{activeGroup?.sessions.length || 0} 条会话</Badge>
              </div>
              <div className="grid grid-cols-[auto_minmax(0,1.8fr)_minmax(160px,0.8fr)_120px] gap-3 border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                <span />
                <span>会话标题</span>
                <span>供应商 / 模型</span>
                <span className="text-right">更新时间</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {activeGroup?.sessions.map((session) => (
                  <SessionListRow
                    key={session.id}
                    session={session}
                    selected={selectedIdSet.has(session.id)}
                    onToggle={() => toggleSession(session.id)}
                  />
                ))}
                {!loading && !activeGroup ? (
                  <div className="flex h-52 items-center justify-center text-sm text-muted-foreground">
                    暂无会话
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 className="size-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>删除选中的会话？</AlertDialogTitle>
            <AlertDialogDescription>
              会删除 SQLite 线程记录、rollout 文件和 session_index 条目。删除前会移动 rollout 到备份目录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <div className="font-medium">选中 {selectedIds.length} 个会话</div>
            <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {selectedIds.slice(0, 8).join(", ")}
              {selectedIds.length > 8 ? ` ... 还有 ${selectedIds.length - 8} 个` : ""}
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={working}
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearBackupsOpen} onOpenChange={setClearBackupsOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Trash2 className="size-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>清空会话备份？</AlertDialogTitle>
            <AlertDialogDescription>
              会删除 provider-sync 备份目录下的所有备份，删除后不能从这些备份恢复同步前或删除前的状态。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <div className="font-medium">
              {status ? `${status.backupCount} 个备份 / ${formatBytes(status.backupBytes)}` : "-"}
            </div>
            <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {status?.backupRoot || ""}
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={working}
              onClick={(event) => {
                event.preventDefault()
                void confirmClearBackups()
              }}
            >
              清空备份
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
