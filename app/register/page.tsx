"use client"

import { useState } from "react"
import Link from "next/link"
import { ThemeProvider } from "@/lib/theme-provider"
import { ThemeToggle } from "@/components/theme-toggle"

export default function RegisterPage() {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError("")
    setMessage("")
    if (password !== confirm) {
      setError("两次输入的密码不一致")
      return
    }
    setBusy(true)
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      const payload = (await response.json().catch(() => null)) as
        | { error?: string | { message?: string }; message?: string }
        | null
      if (!response.ok) {
        const text =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message || payload?.message
        throw new Error(text || "注册失败")
      }
      setMessage(payload?.message || "注册成功，请等待管理员审批")
      setPassword("")
      setConfirm("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const content = (
    <main className="relative flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg"
      >
        <h1 className="text-lg font-semibold">注册账号</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          注册后需要管理员审批才能登录。审批通过时配置为空，需要自己添加供应商。
        </p>
        <label className="mt-5 block text-sm font-medium" htmlFor="username">
          用户名
        </label>
        <input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="3-32 位字母、数字、下划线、点或短横线"
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          required
        />
        <label className="mt-4 block text-sm font-medium" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="至少 8 位"
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          required
        />
        <label className="mt-4 block text-sm font-medium" htmlFor="confirm">
          确认密码
        </label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          required
        />
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        {message ? (
          <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{message}</p>
        ) : null}
        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="mt-5 h-9 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 dark:bg-secondary dark:text-secondary-foreground"
        >
          {busy ? "提交中…" : "提交注册"}
        </button>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          已有账号？
          <Link href="/login" className="ml-1 underline underline-offset-4">
            返回登录
          </Link>
        </p>
      </form>
    </main>
  )
  return <ThemeProvider>{content}</ThemeProvider>
}
