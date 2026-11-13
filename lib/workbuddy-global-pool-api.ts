"use client"

import type {
  WorkbuddyGlobalBalance,
  WorkbuddyGlobalLoginPoll,
  WorkbuddyGlobalLoginStart,
  WorkbuddyGlobalPoolSnapshot,
} from "./workbuddy-global-pool-types"

function parseResponse<T>(response: Response): Promise<T> {
  return response.json().then((body) => {
    if (response.ok) return body as T
    const message =
      body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
        ? ((body as Record<string, unknown>).error as string)
        : `${response.status} ${response.statusText}`
    throw new Error(message)
  })
}

/** 国际版号池快照（含每个账号的余额，余额失败会带 balanceError）。 */
export async function fetchGlobalPoolEntries(): Promise<WorkbuddyGlobalPoolSnapshot> {
  return parseResponse<WorkbuddyGlobalPoolSnapshot>(
    await fetch("/api/workbuddy-global-pool", { cache: "no-store" }),
  )
}

export async function importGlobalPoolAccount(credentials: string) {
  return parseResponse<{ ok: boolean }>(
    await fetch("/api/workbuddy-global-pool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentials }),
    }),
  )
}

export async function globalPoolAccountAction(
  uid: string,
  action: "disable" | "enable" | "unban" | "remove" | "balance" | "active",
): Promise<{ ok: boolean; balance?: WorkbuddyGlobalBalance; activeUid?: string }> {
  return parseResponse(
    await fetch(`/api/workbuddy-global-pool/${encodeURIComponent(uid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  )
}

/** 发起国际版授权登录：拿授权 URL。 */
export async function startGlobalPoolLogin(): Promise<WorkbuddyGlobalLoginStart> {
  return parseResponse(
    await fetch("/api/workbuddy-global-pool/login", { method: "POST" }),
  )
}

/** 轮询国际版登录态（每 3 秒一次，直到 done=true）。 */
export async function pollGlobalPoolLogin(
  state: string,
): Promise<WorkbuddyGlobalLoginPoll> {
  return parseResponse(
    await fetch(`/api/workbuddy-global-pool/login?state=${encodeURIComponent(state)}`, {
      cache: "no-store",
    }),
  )
}
