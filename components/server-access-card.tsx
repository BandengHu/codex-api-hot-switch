"use client"

import { useEffect, useState } from "react"
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  fetchCurrentApiKey,
  fetchServerAccessStatus,
  logoutServerSession,
  rotateServerApiKey,
  type ServerAccessStatus,
} from "@/lib/server-access-api"

export function ServerAccessCard() {
  const [status, setStatus] = useState<ServerAccessStatus | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [newKey, setNewKey] = useState("")
  const [copied, setCopied] = useState(false)
  const [currentKey, setCurrentKey] = useState("")
  const [keyVisible, setKeyVisible] = useState(false)
  const [keyNotice, setKeyNotice] = useState("")
  const [currentCopied, setCurrentCopied] = useState(false)

  useEffect(() => {
    fetchServerAccessStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  const localMode = status?.localMode === true

  useEffect(() => {
    //本机模式没有服务器 API Key，不需要请求，也不该显示错误。
    if (!status || localMode) return
    fetchCurrentApiKey()
      .then((result) => {
        setCurrentKey(result.apiKey)
        setKeyNotice("")
      })
      .catch((error) => {
        setCurrentKey("")
        setKeyNotice(error instanceof Error ? error.message : String(error))
      })
  }, [status, localMode])

  async function handleRotate() {
    setRotating(true)
    try {
      const result = await rotateServerApiKey()
      setNewKey(result.apiKey)
      setCurrentKey(result.apiKey)
      setKeyVisible(true)
      setKeyNotice("")
      setStatus(result)
      setConfirmOpen(false)
      toast.success("已生成新的服务器 API Key")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRotating(false)
    }
  }

  async function copyKey(value: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      //非安全上下文或浏览器拒绝剪贴板权限时，退回手动选中复制。
      return false
    }
  }

  async function handleCopy() {
    if (await copyKey(newKey)) {
      setCopied(true)
      toast.success("已复制新 API Key")
      setTimeout(() => setCopied(false), 1500)
      return
    }
    toast.error("浏览器阻止了剪贴板写入，请手动选中复制")
  }

  async function handleCopyCurrent() {
    if (await copyKey(currentKey)) {
      setCurrentCopied(true)
      toast.success("已复制当前 API Key")
      setTimeout(() => setCurrentCopied(false), 1500)
      return
    }
    setKeyVisible(true)
    toast.error("浏览器阻止了剪贴板写入，已展开明文，请手动选中复制")
  }

  async function handleLogout() {
    try {
      await logoutServerSession()
      window.location.href = "/login"
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4" />
          账号与访问密钥
        </CardTitle>
        <CardDescription>
          每个账号的配置互不可见；API 调用只认本账号的 API Key，网页登录只用于控制台，会话有效 24 小时。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
          <div className="text-sm font-medium">我的 API Key</div>
          {currentKey ? (
            <>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={
                    keyVisible
                      ? currentKey
                      : `${currentKey.slice(0, 6)}${"•".repeat(18)}${currentKey.slice(-4)}`
                  }
                  className="font-mono"
                  aria-label="当前账号 API Key"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setKeyVisible((value) => !value)}
                >
                  {keyVisible ? <EyeOff /> : <Eye />}
                  <span className="sr-only">{keyVisible ? "隐藏" : "显示"} API Key</span>
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => void handleCopyCurrent()}
                >
                  {currentCopied ? <Check /> : <Copy />}
                  <span className="sr-only">复制当前 API Key</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                用于 Codex / MCP 调用本账号的 <span className="font-mono">/v1</span>{" "}
                接口；网页登录 Cookie 不能调用 API。
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {keyNotice || "正在读取当前 API Key…"}
            </p>
          )}
        </div>

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-border p-3">
            <div className="text-muted-foreground">当前账号</div>
            <div className="mt-1 font-medium">
              {status?.localMode
                ? "本机模式（免登录）"
                : status?.account
                  ? `${status.account.username}${status.account.role === "admin" ? "（管理员）" : ""}`
                  : "未登录"}
            </div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-muted-foreground">密钥更新时间</div>
            <div className="mt-1 font-medium">
              {status?.updatedAt
                ? new Date(status.updatedAt).toLocaleString("zh-CN")
                : "—"}
            </div>
          </div>
        </div>

        {newKey ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <div className="text-sm font-medium">新 API Key（只显示这一次）</div>
            <div className="flex gap-2">
              <Input readOnly value={newKey} className="font-mono" />
              <Button variant="outline" size="icon" onClick={() => void handleCopy()}>
                {copied ? <Check /> : <Copy />}
                <span className="sr-only">复制新 API Key</span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              旧 Key 已立即失效。请先更新调用方配置，再关闭此提示。
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setConfirmOpen(true)}>
            <RefreshCw data-icon="inline-start" />
            更换服务器 API Key
          </Button>
          <Button variant="ghost" onClick={() => void handleLogout()}>
            <LogOut data-icon="inline-start" />
            退出登录
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4" />
              更换服务器 API Key
            </DialogTitle>
            <DialogDescription>
              生成后旧 Key 立即失效，所有使用旧 Key 的客户端需要同步更新。新 Key
              只显示一次，请先复制保存。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void handleRotate()} disabled={rotating}>
              {rotating ? "生成中…" : "确认更换"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
