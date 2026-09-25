"use client"

import type {
 WorkbuddyAutomationResult,
 WorkbuddyLoginPoll,
 WorkbuddyLoginStart,
 WorkbuddyPoolEntryView,
 WorkbuddyPoolGrowthTask,
 WorkbuddyTaskAction,
} from "./workbuddy-pool-types"

function parseResponse<T>(response: Response): Promise<T> {
 return response.json().then((body) => {
 if (response.ok) return body as T
 const message =
 body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
 ? (body as Record<string, unknown>).error as string
 : `${response.status} ${response.statusText}`
 throw new Error(message)
 })
}

export async function fetchPoolEntries(): Promise<WorkbuddyPoolEntryView[]> {
 const body = await parseResponse<{ entries: WorkbuddyPoolEntryView[] }>(
 await fetch("/api/workbuddy-pool", { cache: "no-store" }),
 )
 return body.entries
}

export async function importPoolAccount(credentials: string) {
 return parseResponse<{ ok: boolean }>(
 await fetch("/api/workbuddy-pool", {
 method: "POST",
 headers: { "content-type": "application/json" },
 body: JSON.stringify({ credentials }),
 }),
 )
}

export async function fetchPoolTasks(uid: string): Promise<WorkbuddyPoolGrowthTask[]> {
 const body = await parseResponse<{ tasks: WorkbuddyPoolGrowthTask[] }>(
 await fetch(`/api/workbuddy-pool/${encodeURIComponent(uid)}`, { cache: "no-store" }),
 )
 return body.tasks
}

export async function poolAccountAction(
 uid: string,
 action: "disable" | "enable" | "remove",
): Promise<{ ok: boolean }> {
 return parseResponse(
 await fetch(`/api/workbuddy-pool/${encodeURIComponent(uid)}`, {
 method: "POST",
 headers: { "content-type": "application/json" },
 body: JSON.stringify({ action }),
 }),
 )
}

export async function poolTaskAction(
uid: string,
action: "claim" | "automate",
taskCode: string,
): Promise<{ ok: boolean; result?: WorkbuddyAutomationResult }> {
return parseResponse(
await fetch(`/api/workbuddy-pool/${encodeURIComponent(uid)}`, {
method: "POST",
headers: { "content-type": "application/json" },
body: JSON.stringify({ action, taskCode }),
}),
)
}

/**一键完成该账号全部可自动任务（耗时较长，含真实对话）。 */
export async function poolAutomateAll(
 uid: string,
): Promise<{ ok: boolean; results?: WorkbuddyAutomationResult[] }> {
 return parseResponse(
 await fetch(`/api/workbuddy-pool/${encodeURIComponent(uid)}`, {
 method: "POST",
 headers: { "content-type": "application/json" },
 body: JSON.stringify({ action: "automate-all" }),
 }),
 )
}

/**可自动完成的任务清单（动作表）。 */
export async function fetchTaskActions(): Promise<WorkbuddyTaskAction[]> {
 const body = await parseResponse<{ actions: WorkbuddyTaskAction[] }>(
 await fetch("/api/workbuddy-pool/actions", { cache: "no-store" }),
 )
 return body.actions
}

/**发起浏览器授权登录：拿授权 URL。 */
export async function startPoolLogin(): Promise<WorkbuddyLoginStart> {
 return parseResponse(await fetch("/api/workbuddy-pool/login", { method: "POST" }))
}

/**轮询登录态（每3秒一次，直到 done=true）。 */
export async function pollPoolLogin(state: string): Promise<WorkbuddyLoginPoll> {
 return parseResponse(
 await fetch(`/api/workbuddy-pool/login?state=${encodeURIComponent(state)}`, {
 cache: "no-store",
 }),
 )
}
