"use client"

import type {
 WorkbuddyAutomationResult,
 WorkbuddyPoolEntryView,
 WorkbuddyPoolGrowthTask,
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
