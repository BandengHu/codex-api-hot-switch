"use client"

import { useCallback, useEffect, useState } from "react"
import {
 Coins,
 CheckCircle2,
 CircleSlash,
 ExternalLink,
 Power,
 Plus,
 RefreshCw,
 Sun,
 Trash2,
 Users,
 Zap,
} from "lucide-react"
import {
 Card,
 CardAction,
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
 Select,
 SelectContent,
 SelectGroup,
 SelectItem,
 SelectTrigger,
 SelectValue,
} from "@/components/ui/select"
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
 fetchTaskActions,
 importPoolAccount,
 poolAccountAction,
 poolAutomateAll,
 poolDailyRewards,
 poolTaskAction,
 setActivePoolAccount,
} from "@/lib/workbuddy-pool-api"
import type {
 WorkbuddyDailyStep,
 WorkbuddyPoolEntryView,
 WorkbuddyPoolGrowthTask,
 WorkbuddyTaskAction,
} from "@/lib/workbuddy-pool-types"
import { toast } from "sonner"
import { WorkbuddyPoolLoginDialog } from "./workbuddy-pool-login-dialog"

type BusyAction =
 | "refresh"
 | "import"
 | "switch"
 | { uid: string; action: string; taskCode?: string }

export function WorkbuddyPoolView() {
 const [entries, setEntries] = useState<WorkbuddyPoolEntryView[]>([])
 const [actions, setActions] = useState<Record<string, WorkbuddyTaskAction>>({})
 /**当前真正的转发账号（后端解出的值，切号只改它）。 */
 const [activeUid, setActiveUid] = useState("local")
 /**下拉框里正在查看的账号：只影响本页展示，不改转发出口。 */
 const [viewUid, setViewUid] = useState("local")
 const [tasks, setTasks] = useState<WorkbuddyPoolGrowthTask[]>([])
 const [dailySteps, setDailySteps] = useState<WorkbuddyDailyStep[] | null>(null)
 const [busy, setBusy] = useState<BusyAction | null>("refresh")
 const [importOpen, setImportOpen] = useState(false)
 const [loginOpen, setLoginOpen] = useState(false)
 const [credentials, setCredentials] = useState("")

 const refresh = useCallback(async () => {
 setBusy("refresh")
 try {
 //动作表决定哪些任务能一键跑；拉不到时退化为「全部可点」，由后端再判一次。
 const actionList = await fetchTaskActions().catch(() => [])
 setActions(Object.fromEntries(actionList.map((action) => [action.taskCode, action])))
 const snapshot = await fetchPoolEntries()
 setEntries(snapshot.entries)
 setActiveUid(snapshot.activeUid)
 } catch (error) {
 toast.error(error instanceof Error ? error.message : String(error))
 } finally {
 setBusy(null)
 }
 }, [])

 useEffect(() => {
 void refresh()
 }, [refresh])

 /**
 * 拉某个账号的任务列表。
 *
 * 只在用户从下拉框选中账号时触发——不再像以前那样把池里每个账号的任务全铺开，
 * 那样账号一多页面就被几十个卡片淹掉。
 */
 const loadTasks = useCallback(async (uid: string) => {
 setBusy("refresh")
 setDailySteps(null)
 try {
 setTasks(await fetchPoolTasks(uid))
 } catch (error) {
 setTasks([])
 toast.error(error instanceof Error ? error.message : String(error))
 } finally {
 setBusy(null)
 }
 }, [])

 useEffect(() => {
 void loadTasks(viewUid)
 }, [loadTasks, viewUid])

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

 async function handleAutomateAll(uid: string) {
 setBusy({ uid, action: "automate-all" })
 try {
 const { results } = await poolAutomateAll(uid)
 const items = results ?? []
 const done = items.filter((item) => item.status === "done").length
 const claimed = items.filter((item) => item.claimed).length
 toast.success(`已跑完 ${done}项可自动任务，本轮领奖 ${claimed}个`)
 await refresh()
 await loadTasks(uid)
 } catch (error) {
 toast.error(error instanceof Error ? error.message : String(error))
 } finally {
 setBusy(null)
 }
 }

 /**切换代理转发的生效账号：这是唯一的换号入口，不做自动轮转。 */
 async function handleSwitchActive(uid: string) {
 setBusy("switch")
 try {
 const { activeUid: next } = await setActivePoolAccount(uid)
 setActiveUid(next)
 const entry = entries.find((candidate) => candidate.uid === next)
 toast.success(`转发账号已切到 ${entry?.nickname || next}`)
 } catch (error) {
 toast.error(error instanceof Error ? error.message : String(error))
 } finally {
 setBusy(null)
 }
 }

 /**一键领当日积分：签到 /连登兑换 /抽奖 /礼包 /补偿 /补签。 */
 async function handleDailyRewards(uid: string) {
 setBusy({ uid, action: "daily" })
 try {
 const { result } = await poolDailyRewards(uid)
 setDailySteps(result?.steps ?? null)
 if (!result) {
 toast.success("每日领取已执行")
 } else if (result.creditTotal >0) {
 toast.success(`本轮入账 +${result.creditTotal}分${result.streakDays ? `（连登 ${result.streakDays}天）` : ""}`)
 } else {
 const done = result.steps.filter((step) => step.status === "done").length
 toast.success(done ? `已完成 ${done}步，本轮无新增积分` : "本轮没有可领取的项")
 }
 await refresh()
 await loadTasks(uid)
 } catch (error) {
 toast.error(error instanceof Error ? error.message : String(error))
 } finally {
 setBusy(null)
 }
 }

 /**当前是否正在执行该账号的指定动作；taskCode省略时只按 uid+action匹配。 */
 function isBusyFor(uid: string, action: string, taskCode?: string) {
 if (busy === null || typeof busy !== "object") return false
 if (busy.uid !== uid || busy.action !== action) return false
 return taskCode === undefined || busy.taskCode === taskCode
 }

 const totalCredit = entries.reduce(
 (sum, entry) => sum + (entry.balance?.remain ??0),
 0,
 )
 const activeCount = entries.filter((entry) => !entry.disabled).length
 /**下拉里可选来做操作的账号（禁用的不出现在列表里）。 */
 const selectableEntries = entries.filter((entry) => !entry.disabled)
 const viewEntry = entries.find((entry) => entry.uid === viewUid)
 const viewTaskList = tasks
 const viewAutoable = viewTaskList.filter(
 (task) => !task.claimed && !task.locked && Boolean(actions[task.taskCode]),
 )
 const activeEntry = entries.find((entry) => entry.uid === activeUid)

 return (
 <div className="flex flex-col gap-5">
 <div className="flex flex-wrap items-center justify-between gap-3">
 <div>
 <h1 className="flex items-center gap-2 text-lg font-semibold">
 <Users className="size-5" />
 WorkBuddy号池
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
 <Button variant="outline" onClick={() => setLoginOpen(true)} disabled={busy !== null}>
 <ExternalLink className="size-4" />
授权登录
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
 <TableHead>转发出口</TableHead>
 <TableHead className="text-right">操作</TableHead>
 </TableRow>
 </TableHeader>
 <TableBody>
 {entries.map((entry) => {
 const isActive = entry.uid === activeUid
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
 ) : (
 <Badge variant="secondary">正常</Badge>
 )}
 </TableCell>
 <TableCell>
 {isActive ? (
 <Badge>当前使用</Badge>
 ) : (
 <Button
 variant="ghost"
 size="sm"
 onClick={() => void handleSwitchActive(entry.uid)}
 disabled={entry.disabled || busy !== null}
 >
 {busy === "switch" ? <Spinner className="size-4" /> : null}
 设为转发
 </Button>
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
 <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
号池为空，点右上角「授权登录」或「导入账号」添加
 </TableCell>
 </TableRow>
 ) : null}
 </TableBody>
 </Table>
 </CardContent>
 </Card>

  {/* 任务区：只展示下拉选中的那一个账号，不再把池里所有账号的卡片全铺开。 */}
  <Card>
  <CardHeader>
  <CardTitle className="text-base">账号任务</CardTitle>
  <CardDescription>
  {activeEntry ? `当前转发：${activeEntry.nickname || activeEntry.uid}` : "当前转发：本机账号"}
  </CardDescription>
  <CardAction>
  <div className="flex flex-wrap items-center gap-2">
  <Select value={viewUid} onValueChange={setViewUid}>
  <SelectTrigger className="w-56">
  <SelectValue placeholder="选择账号" />
  </SelectTrigger>
  <SelectContent>
  <SelectGroup>
  {selectableEntries.map((entry) => (
  <SelectItem key={entry.uid} value={entry.uid}>
  {entry.uid === activeUid
  ? `${entry.nickname || entry.uid}（转发中）`
  : entry.nickname || entry.uid}
  </SelectItem>
  ))}
  </SelectGroup>
  </SelectContent>
  </Select>
  <Button
  size="sm"
  variant="outline"
  onClick={() => void handleDailyRewards(viewUid)}
  disabled={busy !== null || viewEntry?.disabled}
  >
  {isBusyFor(viewUid, "daily") ? <Spinner className="size-4" /> : <Sun className="size-4" />}
  一键领积分
  </Button>
  <Button
  size="sm"
  onClick={() => void handleAutomateAll(viewUid)}
  disabled={busy !== null || !viewAutoable.length}
  >
  {isBusyFor(viewUid, "automate-all") ? <Spinner className="size-4" /> : <Zap className="size-4" />}
  一键全部任务
  </Button>
  </div>
  </CardAction>
  </CardHeader>
  <CardContent className="flex flex-col gap-3">
  {dailySteps ? (
  <div className="flex flex-col gap-1 rounded-md border p-2">
  <div className="text-sm font-medium">每日领取结果</div>
  {dailySteps.map((step) => (
  <div key={step.key} className="flex items-start gap-2 text-xs">
  {step.status === "done" ? (
  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
  ) : step.status === "error" ? (
  <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-destructive" />
  ) : (
  <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  )}
  <span className="text-muted-foreground">{step.label}</span>
  <span className="min-w-0 flex-1">{step.message}</span>
  </div>
  ))}
  </div>
  ) : null}

  {!viewTaskList.length ? (
  <div className="py-6 text-center text-sm text-muted-foreground">
  {viewEntry ? "该账号暂无成长任务，或任务列表拉取失败" : "请选择一个账号"}
  </div>
  ) : (
  <div className="flex flex-col gap-2">
  {viewTaskList.map((task) => {
  const action = actions[task.taskCode]
  return (
  <div key={task.taskCode} className="flex items-center justify-between gap-2 rounded-md border p-2">
  <div className="min-w-0 flex-1">
  <div className="flex items-center gap-2">
  <span className="truncate text-sm font-medium">{task.title}</span>
  {task.claimed ? (
  <Badge variant="secondary">已领</Badge>
  ) : task.claimable ? (
  <Badge>可领</Badge>
  ) : task.locked ? (
  <Badge variant="outline">未解锁</Badge>
  ) : null}
  {action ? (
  <Badge variant={action.attempt ? "outline" : "secondary"}>
  {action.attempt ? "可尝试" : "可自动"}
  </Badge>
  ) : (
  <Badge variant="outline">需手动</Badge>
  )}
  </div>
  <div className="text-xs text-muted-foreground">
  {action?.desc || task.taskDesc || task.description || task.taskCode}
  {task.target >0 ? ` · ${task.current}/${task.target}` : ""}
  {task.rewardCredit >0 ? ` · +${task.rewardCredit}分` : ""}
  </div>
  </div>
  <div className="flex shrink-0 gap-1">
  <Button
  size="sm"
  variant="outline"
  onClick={() => void handleTaskAction(viewUid, "automate", task.taskCode)}
  disabled={busy !== null || task.claimed || task.locked || !action}
  >
  {isBusyFor(viewUid, "automate", task.taskCode) ? <Spinner className="size-4" /> : null}
  自动完成
  </Button>
  <Button
  size="sm"
  onClick={() => void handleTaskAction(viewUid, "claim", task.taskCode)}
  disabled={busy !== null || !task.claimable}
  >
  {isBusyFor(viewUid, "claim", task.taskCode) ? <Spinner className="size-4" /> : null}
  领奖
  </Button>
  </div>
  </div>
  )
  })}
  </div>
  )}
  </CardContent>
  </Card>

 <Dialog open={importOpen} onOpenChange={setImportOpen}>
 <DialogContent className="sm:max-w-lg">
 <DialogHeader>
 <DialogTitle>导入 WorkBuddy账号</DialogTitle>
 <DialogDescription>
粘贴从桌面端导出的凭据 JSON（与 workbuddy-desktop.info同格式）
 </DialogDescription>
 </DialogHeader>
 <Input placeholder="自定义文件名（可选，默认按 uid）" disabled />
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

 <WorkbuddyPoolLoginDialog
 open={loginOpen}
 onOpenChange={setLoginOpen}
 onLoggedIn={(message) => {
 toast.success(message)
 void refresh()
 }}
 />
 </div>
 )
}
