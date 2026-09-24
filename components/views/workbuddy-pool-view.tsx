"use client"

import { useCallback, useEffect, useState } from "react"
import {
 Coins,
 Power,
 Plus,
 RefreshCw,
 Trash2,
 Users,
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
import {
 Table,
 TableBody,
 TableCell,
 TableHead,
 TableHeader,
 TableRow,
} from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import {
 Dialog,
 DialogContent,
 DialogDescription,
 DialogFooter,
 DialogHeader,
 DialogTitle,
} from "@/components/ui/dialog"
import {
 fetchPoolEntries,
 fetchPoolTasks,
 importPoolAccount,
 poolAccountAction,
 poolTaskAction,
} from "@/lib/workbuddy-pool-api"
import type {
 WorkbuddyPoolEntryView,
 WorkbuddyPoolGrowthTask,
} from "@/lib/workbuddy-pool-types"
import { toast } from "sonner"

type BusyAction =
 | "refresh"
 | "import"
 | { uid: string; action: string; taskCode?: string }

export function WorkbuddyPoolView() {
 const [entries, setEntries] = useState<WorkbuddyPoolEntryView[]>([])
 const [tasks, setTasks] = useState<Record<string, WorkbuddyPoolGrowthTask[]>>({})
 const [busy, setBusy] = useState<BusyAction | null>("refresh")
 const [importOpen, setImportOpen] = useState(false)
 const [credentials, setCredentials] = useState("")

 const refresh = useCallback(async () => {
 setBusy("refresh")
 try {
 const list = await fetchPoolEntries()
 setEntries(list)
 const taskMap: Record<string, WorkbuddyPoolGrowthTask[]> = {}
 for (const entry of list) {
 if (entry.disabled) continue
 try {
 taskMap[entry.uid] = await fetchPoolTasks(entry.uid)
 } catch {
 // 任务列表拉不到（token 过期/网络）不影响号池列表展示。
 }
 }
 setTasks(taskMap)
 } catch (error) {
 toast.error(error instanceof Error ? error.message : String(error))
 } finally {
 setBusy(null)
 }
 }, [])

 useEffect(() => {
 void refresh()
 }, [refresh])

 async function handleImport() {
 setBusy("import")
 try {
 await importPoolAccount(credentials)
 toast.success("已导入号池")
 setImportOpen(false)
 setCredentials("")
 await refresh()
 } catch (error) {
 toast.error(error instanceof Error ? error.message : String(error))
 } finally {
 setBusy(null)
 }
 }

 async function handleAccountAction(
 uid: string,
 action: "disable" | "enable" | "remove",
 ) {
 setBusy({ uid, action })
 try {
 await poolAccountAction(uid, action)
 toast.success(action === "remove" ? "已移除" : action === "disable" ? "已禁用" : "已启用")
 await refresh()
 } catch (error) {
 toast.error(error instanceof Error ? error.message : String(error))
 } finally {
 setBusy(null)
 }
 }

 async function handleTaskAction(
 uid: string,
 action: "claim" | "automate",
 taskCode: string,
 ) {
 setBusy({ uid, action, taskCode })
 try {
 const { result } = await poolTaskAction(uid, action, taskCode)
 if (result) toast.success(result.message)
 await refresh()
 } catch (error) {
 toast.error(error instanceof Error ? error.message : String(error))
 } finally {
 setBusy(null)
 }
 }

 const totalCredit = entries.reduce(
 (sum, entry) => sum + (entry.balance?.remain ??0),
0,
 )
 const activeCount = entries.filter((entry) => !entry.disabled).length

 return (
 <div className="flex flex-col gap-5">
 <div className="flex flex-wrap items-center justify-between gap-3">
 <div>
 <h1 className="flex items-center gap-2 text-lg font-semibold">
 <Users className="size-5" />
 WorkBuddy 号池
 </h1>
 <p className="text-sm text-muted-foreground">
管理本机账号与导入账号的任务/积分，支持一键完成与领奖
 </p>
 </div>
 <div className="flex items-center gap-2">
 <Button variant="outline" onClick={() => void refresh()} disabled={busy !== null}>
 {busy === "refresh" ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
刷新
 </Button>
 <Button onClick={() => setImportOpen(true)} disabled={busy !== null}>
 <Plus className="size-4" />
 导入账号
 </Button>
 </div>
 </div>

 <div className="flex gap-4">
 <Card className="flex-1">
 <CardHeader className="pb-2">
 <CardDescription>账号总数</CardDescription>
 <CardTitle className="text-2xl">{entries.length}</CardTitle>
 </CardHeader>
 </Card>
 <Card className="flex-1">
 <CardHeader className="pb-2">
 <CardDescription>可用账号</CardDescription>
 <CardTitle className="text-2xl">{activeCount}</CardTitle>
 </CardHeader>
 </Card>
 <Card className="flex-1">
 <CardHeader className="pb-2">
 <CardDescription>剩余积分合计</CardDescription>
 <CardTitle className="flex items-center gap-2 text-2xl">
 <Coins className="size-5 text-amber-500" />
 {totalCredit.toLocaleString()}
 </CardTitle>
 </CardHeader>
 </Card>
 </div>

 <Card>
 <CardHeader>
 <CardTitle>账号列表</CardTitle>
 <CardDescription>本机账号始终存在；导入账号以文件形式保存在号池目录</CardDescription>
 </CardHeader>
 <CardContent>
 <Table>
 <TableHeader>
 <TableRow>
 <TableHead>昵称 / uid</TableHead>
 <TableHead>来源</TableHead>
 <TableHead className="text-right">剩余积分</TableHead>
 <TableHead>状态</TableHead>
 <TableHead className="text-right">操作</TableHead>
 </TableRow>
 </TableHeader>
 <TableBody>
 {entries.map((entry) => {
 const taskList = tasks[entry.uid] ?? []
 const claimable = taskList.filter((task) => task.claimable)
 return (
 <TableRow key={entry.uid}>
 <TableCell>
 <div className="font-medium">{entry.nickname || "(未命名)"}</div>
 <div className="font-mono text-xs text-muted-foreground">{entry.uid}</div>
 </TableCell>
 <TableCell>
 <Badge variant={entry.source === "local" ? "default" : "secondary"}>
 {entry.source === "local" ? "本机" : "导入"}
 </Badge>
 </TableCell>
 <TableCell className="text-right font-mono">
 {entry.balance ? entry.balance.remain.toLocaleString() : "—"}
 </TableCell>
 <TableCell>
 {entry.disabled ? (
 <Badge variant="outline">已禁用</Badge>
 ) : entry.balanceError ? (
 <Badge variant="destructive">凭据异常</Badge>
 ) : claimable.length ? (
 <Badge>{claimable.length} 个可领</Badge>
 ) : (
 <Badge variant="secondary">正常</Badge>
 )}
 </TableCell>
 <TableCell className="text-right">
 <div className="flex justify-end gap-1">
 <Button
 variant="ghost"
 size="sm"
 onClick={() => void handleAccountAction(entry.uid, entry.disabled ? "enable" : "disable")}
 disabled={entry.source === "local" || busy !== null}
 >
 <Power className="size-4" />
 {entry.disabled ? "启用" : "禁用"}
 </Button>
 <Button
 variant="ghost"
 size="sm"
 onClick={() => void handleAccountAction(entry.uid, "remove")}
 disabled={entry.source === "local" || busy !== null}
 >
 <Trash2 className="size-4" />
 </Button>
 </div>
 </TableCell>
 </TableRow>
 )
 })}
 {!entries.length && !busy ? (
 <TableRow>
 <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
 号池为空，点右上角「导入账号」添加
 </TableCell>
 </TableRow>
 ) : null}
 </TableBody>
 </Table>
 </CardContent>
 </Card>

 {entries.filter((entry) => !entry.disabled && (tasks[entry.uid]?.length ??0) >0).map((entry) => (
 <Card key={`tasks-${entry.uid}`}>
 <CardHeader>
 <CardTitle className="text-base">
 {entry.nickname || entry.uid} 的成长任务
 </CardTitle>
 </CardHeader>
 <CardContent>
 <div className="flex flex-col gap-2">
 {(tasks[entry.uid] ?? []).map((task) => (
 <div key={task.taskCode} className="flex items-center justify-between gap-2 rounded-md border p-2">
 <div className="min-w-0 flex-1">
 <div className="flex items-center gap-2">
 <span className="truncate font-medium text-sm">{task.title}</span>
 {task.claimed ? (
 <Badge variant="secondary">已领</Badge>
 ) : task.claimable ? (
 <Badge>可领</Badge>
 ) : task.locked ? (
 <Badge variant="outline">未解锁</Badge>
 ) : null}
 </div>
 <div className="text-xs text-muted-foreground">
 {task.taskDesc || task.description || task.taskCode}
 {task.target >0 ? ` · ${task.current}/${task.target}` : ""}
 {task.rewardCredit >0 ? ` · +${task.rewardCredit}分` : ""}
 </div>
 </div>
 <div className="flex shrink-0 gap-1">
 <Button
 size="sm"
 variant="outline"
 onClick={() => void handleTaskAction(entry.uid, "automate", task.taskCode)}
 disabled={busy !== null || task.claimed || task.locked}
 >
 自动完成
 </Button>
 <Button
 size="sm"
 onClick={() => void handleTaskAction(entry.uid, "claim", task.taskCode)}
 disabled={busy !== null || !task.claimable}
 >
领奖
 </Button>
 </div>
 </div>
 ))}
 </div>
 </CardContent>
 </Card>
 ))}

 <Dialog open={importOpen} onOpenChange={setImportOpen}>
 <DialogContent className="sm:max-w-lg">
 <DialogHeader>
 <DialogTitle>导入 WorkBuddy账号</DialogTitle>
 <DialogDescription>
粘贴从桌面端导出的凭据 JSON（与 workbuddy-desktop.info 同格式）
 </DialogDescription>
 </DialogHeader>
 <Input
 placeholder="自定义文件名（可选，默认按 uid）"
 disabled
 />
 <Textarea
 placeholder='{"auth": {...}, "account": {...}}'
 value={credentials}
 onChange={(event) => setCredentials(event.target.value)}
 className="min-h-40 font-mono text-xs"
 />
 <DialogFooter>
 <Button variant="outline" onClick={() => setImportOpen(false)} disabled={busy === "import"}>
 取消
 </Button>
 <Button onClick={() => void handleImport()} disabled={busy === "import" || !credentials.trim()}>
 {busy === "import" ? <Spinner className="size-4" /> : null}
 导入
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>
 </div>
 )
}
