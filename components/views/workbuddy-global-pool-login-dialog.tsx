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
import { openExternalUrl } from "@/lib/desktop-open-external"
import {
  pollGlobalPoolLogin,
  startGlobalPoolLogin,
} from "@/lib/workbuddy-global-pool-api"
import type { WorkbuddyGlobalLoginStart } from "@/lib/workbuddy-global-pool-types"

/** 轮询间隔：与上游口径一致（3 秒一次）。 */
const POLL_INTERVAL_MS = 3_000

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 登录成功后回调（已写入国际版号池，父组件负责刷新列表）。 */
  onLoggedIn: (message: string) => void
}

/**
 * 国际版（www.workbuddy.ai）授权登录对话框。
 *
 * 走的是国际站设备授权流：平台标识 `workbuddy-ai`，账号信息取
 * `GET /v2/plugin/accounts`，未完成登录时上游回业务码 11217。
 */
export function WorkbuddyGlobalPoolLoginDialog({ open, onOpenChange, onLoggedIn }: Props) {
  const [session, setSession] = useState<WorkbuddyGlobalLoginStart | null>(null)
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

  /**
   * 打开授权页。
   *
   * 安装版走 preload 的 IPC 交给 `shell.openExternal`，直接开系统浏览器；
   * 浏览器里调试时退化成 `window.open`（可能被弹窗拦截，所以失败不抛错）。
   */
  const openInBrowser = useCallback(async (url: string, options: { quiet?: boolean } = {}) => {
    try {
      await openExternalUrl(url)
      return true
    } catch (caught) {
      if (!options.quiet) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
      return false
    }
  }, [])

  const begin = useCallback(async () => {
    setStarting(true)
    setError("")
    setStatus("正在获取国际版授权链接…")
    setSession(null)
    try {
      const started = await startGlobalPoolLogin()
      setSession(started)
      // 拿到链接就直接把系统浏览器拉起来，用户不用再点一次。
      setStatus("已在系统浏览器打开授权页，完成登录后这里会自动继续")
      await openInBrowser(started.url, { quiet: true })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus("")
    } finally {
      setStarting(false)
    }
  }, [openInBrowser])

  useEffect(() => {
    if (!open || !session) {
      stopPolling()
      return
    }
    cancelledRef.current = false
    const tick = async () => {
      try {
        const result = await pollGlobalPoolLogin(session.state)
        if (cancelledRef.current) return
        if (result.done) {
          stopPolling()
          const creditText = result.credits >= 0 ? `，剩余额度 ${result.credits}` : ""
          onLoggedIn(`已登录 ${result.nickname || result.uid}${creditText}`)
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
          <DialogTitle>国际版授权登录</DialogTitle>
          <DialogDescription>
            登录 www.workbuddy.ai（国际站），完成后凭据自动写入国际版号池，无需手工粘贴
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {session ? (
            <>
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="select-all break-all font-mono text-xs">{session.url}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openInBrowser(session.url)}
                >
                  <ExternalLink data-icon="inline-start" />
                  在浏览器打开
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
              点「获取授权链接」后会自动打开系统浏览器，用国际版账号登录并确认授权即可。
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
