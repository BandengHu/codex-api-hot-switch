"use client"

export interface ServerAccessStatus {
  authenticated: boolean
  apiKeyAuthorized: boolean
  configured: boolean
  updatedAt: string
  sessionTtlSeconds: number
  localMode?: boolean
  account?: {
    id: string
    username: string
    role: "admin" | "member"
  } | null
}

export interface RotatedApiKey extends ServerAccessStatus {
  ok: true
  apiKey: string
}

export interface CurrentApiKey {
  ok: true
  apiKey: string
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } | string; message?: string }
    | null
  if (response.ok) return body as T
  const message =
    (typeof body?.error === "string" ? body.error : body?.error?.message) ||
    body?.message ||
    `${response.status} ${response.statusText}`
  throw new Error(message)
}

export async function fetchServerAccessStatus(): Promise<ServerAccessStatus> {
  return parseResponse<ServerAccessStatus>(
    await fetch("/api/auth/status", { cache: "no-store" }),
  )
}

export async function rotateServerApiKey(): Promise<RotatedApiKey> {
  return parseResponse<RotatedApiKey>(
    await fetch("/api/auth/rotate", { method: "POST" }),
  )
}

/**
 * 读取本账号当前 API Key。
 *
 * 后端对旧版只存哈希的账号会返回 409，这里原样抛错，
 * 由界面提示“需更换一次”，而不是伪造一个 Key。
 */
export async function fetchCurrentApiKey(): Promise<CurrentApiKey> {
  return parseResponse<CurrentApiKey>(
    await fetch("/api/auth/key", { cache: "no-store" }),
  )
}

export async function logoutServerSession(): Promise<void> {
  await parseResponse<{ ok: true }>(
    await fetch("/api/auth/logout", { method: "POST" }),
  )
}
