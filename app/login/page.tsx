"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ThemeToggle } from "@/components/theme-toggle"
import { ThemeProvider } from "@/lib/theme-provider"

export default function LoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      })
      const payload = (await response.json().catch(() => null)) as
        | { error?: string | { message?: string }; message?: string }
        | null
      if (!response.ok) {
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : payload?.error?.message || payload?.message
        throw new Error(message || "登录失败")
      }
      router.replace("/")
      router.refresh()
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
        <h1 className="text-lg font-semibold">Codex SwitchGate</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          使用账号登录，会话有效 24 小时。每个账号的配置与密钥互相隔离。
        </p>
        <label className="mt-5 block text-sm font-medium" htmlFor="username">
          用户名
        </label>
        <input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          required
        />
        <label className="mt-4 block text-sm font-medium" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          required
        />
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || !username.trim() || !password}
          className="mt-5 h-9 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 dark:bg-secondary dark:text-secondary-foreground"
        >
          {busy ? "登录中…" : "登录"}
        </button>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          还没有账号？
          <Link href="/register" className="ml-1 underline underline-offset-4">
            注册（需管理员审批）
          </Link>
        </p>
      </form>
    </main>
  )
  return <ThemeProvider>{content}</ThemeProvider>
}
