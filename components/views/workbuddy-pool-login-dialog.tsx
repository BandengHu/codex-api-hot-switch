"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ExternalLink, RefreshCw } from "lucide-react"
import {
 Dialog,
 DialogContent,
 DialogDescription,
 DialogFooter,
 DialogHeader,
 DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { pollPoolLogin, startPoolLogin } from "@/lib/workbuddy-pool-api"
import type { WorkbuddyLoginStart } from "@/lib/workbuddy-pool-types"

/**轮询间隔：与上游口径一致（面板前端每3秒查一次登录态）。 */
const POLL_INTERVAL_MS =3_000

interface Props {
 open: boolean
 onOpenChange: (open: boolean) => void
 /**登录成功后回调（已写入号池，父组件负责刷新列表）。 */
 onLoggedIn: (message: string) => void
}

/**
 *号池「浏览器授权登录」对话框。
 *
 *流程与官方桌面端一致：本地拿授权 URL →用户在浏览器完成登录 →本地轮询 token →
 *凭证落盘进号池（不需要手工粘贴 JSON）。上游没有自渲染二维码端点，所以这里是
 *「复制链接去浏览器」而不是扫码。
 */
export function WorkbuddyPoolLoginDialog({ open, onOpenChange, onLoggedIn }: Props) {
 const [session, setSession] = useState<WorkbuddyLoginStart | null>(null)
 const [status, setStatus] = useState("")
 const [starting, setStarting] = useState(false)
 const [error, setError] = useState("")
 const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
 const cancelledRef = useRef(false)

 const stopPolling = useCallback(() => {
 if (timerRef.current) {
 clearTimeout(timerRef.current)
 timerRef.current = null
 }
 }, [])

 const begin = useCallback(async () => {
 setStarting(true)
 setError("")
 setStatus("正在获取授权链接…")
 setSession(null)
 try {
 const started = await startPoolLogin()
 setSession(started)
 setStatus("请在浏览器打开下面的链接完成登录")
 } catch (caught) {
 setError(caught instanceof Error ? caught.message : String(caught))
 setStatus("")
 } finally {
 setStarting(false)
 }
 }, [])

 //登录态轮询：拿到 done=true即回调父组件刷新号池。
 useEffect(() => {
 if (!open || !session) {
 stopPolling()
 return
 }
 cancelledRef.current = false
 const tick = async () => {
 try {
 const result = await pollPoolLogin(session.state)
 if (cancelledRef.current) return
 if (result.done) {
 stopPolling()
 const creditText = result.credits >=0 ? `，剩余积分 ${result.credits}` : ""
 const checkinText = result.checkinMessage ? `（签到：${result.checkinMessage}）` : ""
 onLoggedIn(`已登录 ${result.nickname || result.uid}${creditText}${checkinText}`)
 onOpenChange(false)
 return
 }
 setStatus(result.message || "等待浏览器完成登录")
 } catch (caught) {
 if (cancelledRef.current) return
 setError(caught instanceof Error ? caught.message : String(caught))
 stopPolling()
 return
 }
 timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS)
 }
 timerRef.current = setTimeout(() => void tick(), POLL_INTERVAL_MS)
 return () => {
 cancelledRef.current = true
 stopPolling()
 }
 }, [open, session, onLoggedIn, onOpenChange, stopPolling])

 useEffect(() => {
 if (!open) {
 setSession(null)
 setStatus("")
 setError("")
 }
 }, [open])

 return (
 <Dialog open={open} onOpenChange={onOpenChange}>
 <DialogContent className="sm:max-w-lg">
 <DialogHeader>
 <DialogTitle>浏览器授权登录</DialogTitle>
 <DialogDescription>
用官方设备授权流程登录（与桌面端一致），完成后凭证自动写入号池，无需手工粘贴
 </DialogDescription>
 </DialogHeader>

 <div className="flex flex-col gap-3">
 {session ? (
 <>
 <div className="rounded-md border bg-muted/40 p-3">
 <div className="break-all font-mono text-xs">{session.url}</div>
 </div>
 <div className="flex flex-wrap gap-2">
 <Button
 variant="outline"
 size="sm"
 onClick={() => window.open(session.url, "_blank", "noopener,noreferrer")}
 >
 <ExternalLink data-icon="inline-start" />
打开授权页面
 </Button>
 <Button
 variant="outline"
 size="sm"
 onClick={() => void navigator.clipboard.writeText(session.url)}
 >
复制链接
 </Button>
 </div>
 </>
 ) : (
 <div className="text-sm text-muted-foreground">
点「获取授权链接」后，在浏览器登录 CodeBuddy账号并确认授权。
 </div>
 )}

 <div className="min-h-5 text-xs text-muted-foreground">
 {starting ? (
 <span className="flex items-center gap-1">
 <Spinner className="size-3" />
 {status}
 </span>
 ) : (
 status
 )}
 </div>
 {error ? <div className="text-xs text-destructive">{error}</div> : null}
 </div>

 <DialogFooter>
 <Button variant="outline" onClick={() => onOpenChange(false)} disabled={starting}>
关闭
 </Button>
 <Button onClick={() => void begin()} disabled={starting}>
 {starting ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
 {session ? "重新获取链接" : "获取授权链接"}
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>
 )
}

