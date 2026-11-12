"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export default function LoginPage() {
  const router = useRouter()
  const [apiKey, setApiKey] = useState("")
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
        body: JSON.stringify({ apiKey }),
      })
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null
      if (!response.ok) throw new Error(payload?.error || "登录失败")
      router.replace("/")
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg"
      >
        <h1 className="text-lg font-semibold">Codex SwitchGate</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          输入服务器 API Key 登录，会话有效 24 小时。
        </p>
        <label className="mt-5 block text-sm font-medium" htmlFor="api-key">
          API Key
        </label>
        <input
          id="api-key"
          type="password"
          autoComplete="current-password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          required
        />
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || !apiKey.trim()}
          className="mt-5 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "登录中…" : "登录"}
        </button>
      </form>
    </main>
  )
}

