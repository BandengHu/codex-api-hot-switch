import "server-only"

import { createHash } from "node:crypto"
import type { WorkbuddyAccount } from "./account"
import { appendTaskDebug } from "./task-debug"

const CLIENT_VERSION = "5.5.6"
const CLI_VERSION = "2.137.1"
const DESKTOP_UA = `WorkBuddy/${CLIENT_VERSION} WorkBuddy/${CLIENT_VERSION} CLI/${CLI_VERSION}`
const BILLING_UA = `WorkBuddy/${CLIENT_VERSION}`
const WEB_UA =
 "Mozilla/5.0 (Windows NT10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"

type UpstreamFingerprint = "billing" | "desktop" | "web"

interface RealmBase {
 site: string
 billing: string
 growth: string
 claim: string
}

const CN_BASE: RealmBase = {
 site: "https://www.codebuddy.cn",
 billing: "https://www.codebuddy.cn",
 growth: "https://copilot.tencent.com",
 claim: "https://www.workbuddy.cn",
}

const GLOBAL_BASE: RealmBase = {
 site: "https://www.workbuddy.ai",
 billing: "https://www.workbuddy.ai",
 growth: "https://www.workbuddy.ai",
 claim: "https://www.workbuddy.ai",
}

export class WorkbuddyTaskApiError extends Error {
 constructor(
 message: string,
 readonly payload: unknown,
 ) {
 super(message)
 this.name = "WorkbuddyTaskApiError"
 }
}

interface TaskFetchInit {
method: "GET" | "POST"
body?: unknown
 fingerprint?: UpstreamFingerprint
 platform?: "web" | "miniprogram"
debug?: boolean
}

function realmBase(account: WorkbuddyAccount): RealmBase {
 return account.domain.includes("workbuddy.ai") ? GLOBAL_BASE : CN_BASE
}

function desktopFingerprint(account: WorkbuddyAccount) {
 return {
 timezone: "Asia/Shanghai",
 reportDelay:2000,
 userId: account.uid,
 username: account.nickname,
 userNickname: account.nickname,
 product: "SaaS",
 releaseDate:1789036585355,
 commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
 ideName: "WorkBuddy",
 ideType: "WorkBuddy",
 ideVersion: CLIENT_VERSION,
 machineId: stableId(account.uid, "machine"),
 sessionId: stableId(account.uid, "session"),
 extName: "workbuddy-desktop",
 extVersion: CLIENT_VERSION,
 os: "win32",
 arch: "x64",
 osVersion: "10.0.26220",
 cpuCores:20,
 memorySize:24,
 }
}

function stableId(uid: string, salt: string) {
 return createHash("sha256").update(`${salt}:${uid}`).digest("hex").slice(0,36)
}

function assertOk(payload: unknown, context: string): Record<string, unknown> {
 if (!payload || typeof payload !== "object") {
 throw new WorkbuddyTaskApiError(`${context}：响应不是 JSON 对象`, payload)
 }

 const record = payload as Record<string, unknown>
 if (record.code !==0 && record.code !== undefined) {
 const message =
 typeof record.msg === "string" ? record.msg : JSON.stringify(record).slice(0,200)
 throw new WorkbuddyTaskApiError(`${context}失败：code=${record.code} ${message}`, payload)
 }

 return record
}

async function taskFetch(
 account: WorkbuddyAccount,
 url: string,
 init: TaskFetchInit,
 context: string,
): Promise<Record<string, unknown>> {
const fingerprint = init.fingerprint ?? "billing"
const startedAt = Date.now()
let response: Response | undefined
const headers: Record<string, string> = {
 authorization: `Bearer ${account.accessToken}`,
 accept: "application/json",
 "content-type": "application/json",
 "x-codebuddy-request": "1",
}

if (fingerprint === "billing") {
 headers["accept-language"] = "zh-CN"
 headers["user-agent"] = BILLING_UA
} else if (fingerprint === "desktop") {
headers.accept = "application/json, text/plain, */*"
headers["content-type"] = "application/json;charset=UTF-8"
 headers["user-agent"] = DESKTOP_UA
headers["x-product"] = "SaaS"
headers["x-request-id"] = `${stableId(account.uid, "req")}${Date.now() %1_000_000}`
headers.origin = "https://copilot.tencent.com"
 headers.referer = "https://copilot.tencent.com/"
 } else {
 headers["user-agent"] = WEB_UA
 }

if (account.uid) {
headers["x-user-id"] = account.uid
}
if (account.domain) {
 headers["x-domain"] =
fingerprint === "desktop" && realmBase(account) === CN_BASE
? "copilot.tencent.com"
: account.domain
}
 if (init.platform) {
 headers["x-client-platform"] = init.platform
 }
 if (fingerprint === "web") {
 headers.origin = "https://www.workbuddy.cn"
 headers.referer = "https://www.workbuddy.cn/profile/growth-center"
 }

 const controller = new AbortController()
 const timeout = setTimeout(() => controller.abort(),20_000)

 try {
 response = await fetch(url, {
 method: init.method,
 headers,
 body: init.body === undefined ? undefined : JSON.stringify(init.body),
 signal: controller.signal,
 cache: "no-store",
 })
 const text = await response.text()

 if (!response.ok) {
throw new WorkbuddyTaskApiError(
`${context}：HTTP ${response.status} ${text.trim().slice(0,200)}`,
 text.trim().slice(0,1000),
)
 }

 let payload: unknown
 try {
 payload = JSON.parse(text)
 } catch {
 throw new WorkbuddyTaskApiError(
 `${context}：响应不是 JSON：${text.trim().slice(0,180)}`,
 text.trim().slice(0,1000),
 )
 }

 return assertOk(payload, context)
 } catch (error) {
 if (error instanceof WorkbuddyTaskApiError) throw error
 if (error instanceof Error && error.name === "AbortError") {
 throw new WorkbuddyTaskApiError(`${context}：请求超时`, undefined)
 }
throw new WorkbuddyTaskApiError(
`${context}：${error instanceof Error ? error.message : String(error)}`,
 undefined,
)
} finally {
clearTimeout(timeout)
if (init.debug) {
 await appendTaskDebug(
 `[workbuddy-task] ${new Date().toISOString()} ${context} ${init.method} ${url} fingerprint=${fingerprint} status=${response?.status} durationMs=${Date.now() - startedAt}`,
 )
}
}
}

export async function fetchGrowthStreak(account: WorkbuddyAccount) {
 const base = realmBase(account)
 const record = await taskFetch(
 account,
 `${base.growth}/activity/growth/streak`,
 { method: "GET" },
 "查询连登状态",
 )
 const data = (record.data ?? {}) as Record<string, unknown>
 const streak = (data.streak ?? {}) as Record<string, unknown>
 return { days: asNumber(streak.days) ??0 }
}

export interface WorkbuddyGrowthTask {
 taskCode: string
 title: string
 description: string
 taskDesc: string
 rewardCredit: number
 rewardEnergy: number
 locked: boolean
 target: number
 current: number
 acceptStatus: string
 status: string
 claimable: boolean
 claimed: boolean
}

export async function listGrowthTasks(account: WorkbuddyAccount): Promise<WorkbuddyGrowthTask[]> {
 const base = realmBase(account)
 const record = await taskFetch(
 account,
 `${base.growth}/v2/activity/growth/tasks`,
 { method: "GET" },
 "获取任务列表",
 )
 const data = record.data as Record<string, unknown> | undefined
 const tasks = Array.isArray(data?.tasks) ? data.tasks : []
 const result: WorkbuddyGrowthTask[] = []

 for (const entry of tasks) {
 if (!entry || typeof entry !== "object") continue
 const item = entry as Record<string, unknown>
 const taskCode = typeof item.task_code === "string" ? item.task_code : ""
 if (!taskCode) continue

 const target = asNumber(item.target) ?? asProgress(item.progress, "target") ??0
 const current = asNumber(item.current) ?? asProgress(item.progress, "current") ??0
 const acceptStatus = typeof item.accept_status === "string" ? item.accept_status : ""
 const claimed = acceptStatus === "claimed"

 result.push({
 taskCode,
 title: typeof item.title === "string" ? item.title : taskCode,
 description: typeof item.description === "string" ? item.description : "",
 taskDesc: typeof item.task_desc === "string" ? item.task_desc : "",
 rewardCredit: asNumber(item.reward_credit) ??0,
 rewardEnergy: asNumber(item.reward_energy) ??0,
 locked: item.locked === true,
 target,
 current,
 acceptStatus,
 status: typeof item.status === "string" ? item.status : "",
 claimable: !claimed && target >0 && current >= target,
 claimed,
 })
 }

 return result
}

export async function acceptGrowthTasks(account: WorkbuddyAccount, taskCodes: string[]) {
 if (!taskCodes.length) return

 const base = realmBase(account)
 await taskFetch(
 account,
 `${base.growth}/v2/activity/growth/tasks/accept`,
 { method: "POST", body: { task_codes: taskCodes } },
 "接受任务",
 )
}

export interface ClaimResult {
 alreadyClaimed: boolean
 credit: number
 energy: number
}

export async function claimGrowthReward(
 account: WorkbuddyAccount,
 taskCode: string,
): Promise<ClaimResult> {
 const base = realmBase(account)
 const url = `${base.claim}/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`
 const record = await taskFetch(
 account,
 url,
 { method: "POST", fingerprint: "web", platform: "web" },
 "领取奖励",
 )
 const data = (record.data ?? {}) as Record<string, unknown>

 return {
 alreadyClaimed: data.already_claimed === true,
 credit: asNumber(data.credit) ??0,
 energy: asNumber(data.energy) ??0,
 }
}

export interface WorkbuddyBalance {
 remain: number
 used: number
 size: number
 packs: number
}

export async function fetchBalance(account: WorkbuddyAccount): Promise<WorkbuddyBalance> {
 const base = realmBase(account)
 const path =
 base === GLOBAL_BASE ? "/billing/meter/get-user-resource" : "/v2/billing/meter/get-user-resource"
 const record = await taskFetch(
 account,
 `${base.billing}${path}`,
 {
 method: "POST",
 body: {
 PageNumber:1,
 PageSize:100,
 ProductCode: "p_tcaca",
 Status: [0,3],
 PackageEndTimeRangeBegin: formatDateTime(new Date()),
 PackageEndTimeRangeEnd: formatDateTime(new Date(Date.now() +365 *100 *86_400_000)),
 },
 },
 "查询余额",
 )

 const data = record.data as Record<string, unknown> | undefined
 const response = data?.Response as Record<string, unknown> | undefined
 const responseData = response?.Data as Record<string, unknown> | undefined
 const accounts = Array.isArray(responseData?.Accounts) ? responseData.Accounts : []
 let remain =0
 let used =0
 let size =0

 for (const entry of accounts) {
 if (!entry || typeof entry !== "object") continue
 const pkg = entry as Record<string, unknown>
 const cycleSize = asNumber(pkg.CycleCapacitySize) ??0
 let packageRemain =0
 let packageUsed =0
 let packageSize =0

 if (cycleSize >0) {
 packageSize = cycleSize
 packageRemain = Math.min(Math.max(asNumber(pkg.CycleCapacityRemain) ??0,0), cycleSize)
 packageUsed = cycleSize - packageRemain
 const reportedUsed = asNumber(pkg.CycleCapacityUsed) ??0
 if (reportedUsed > packageUsed) {
 packageUsed = reportedUsed
 if (cycleSize >= packageUsed) packageRemain = cycleSize - packageUsed
 }
 } else {
 packageRemain = asNumber(pkg.CapacityRemain) ??0
 packageUsed = asNumber(pkg.CapacityUsed) ??0
 packageSize = asNumber(pkg.CapacitySize) ??0
 if (packageUsed ===0 && packageSize > packageRemain) {
 packageUsed = packageSize - packageRemain
 }
 }

 remain += packageRemain
 used += packageUsed
 size += packageSize
 }

 const totalDosage = asNumber(responseData?.TotalDosage) ??0
 if (totalDosage > size) {
 size = totalDosage
 used = Math.max(used, size - remain)
 }

 return { remain, used, size, packs: accounts.length }
}

export async function dailyCheckin(account: WorkbuddyAccount) {
 const base = realmBase(account)
 const path =
 base === GLOBAL_BASE ? "/billing/meter/daily-checkin" : "/v2/billing/meter/daily-checkin"
 await taskFetch(account, `${base.billing}${path}`, { method: "POST", body: {} }, "每日签到")
}

export async function reportChatActivity(
 account: WorkbuddyAccount,
 conversationId: string,
 requestId: string,
modelId = "deepseek-v4-flash",
modelName = "DeepSeek V4 Flash",
) {
 const base = realmBase(account)
 const now = Date.now()
 await taskFetch(
 account,
 `${base.billing}/v2/report`,
{
method: "POST",
fingerprint: "desktop",
 debug: process.env.WORKBUDDY_TASK_DEBUG === "1",
body: [
 {
 ...createChatRequestEvent(
 account,
 conversationId,
 requestId || conversationId,
 now,
 modelId,
 modelName,
 ),
},
],
 },
 "上报对话活跃",
 )
}

function createChatRequestEvent(
account: WorkbuddyAccount,
conversationId: string,
 requestId: string,
now: number,
modelId: string,
 modelName: string,
) {
 return {
 eventCode: "chat_request_send",
 timestamp: now,
 reportDelay:0,
 mode: "craft",
conversationId,
 requestId,
 inputLength:12,
 requestModelId: modelId,
 requestModelName: modelName,
 isPlan: false,
 isAutoExecuteTerminal: false,
 isAutoModify: false,
 codebaseEnable: false,
 maxToken:0,
 maxSteps:0,
 temperature:0,
 maxRetries:0,
 mentionContexts: [],
 knowledgeId: [],
 knowledgeName: [],
 codebaseId: "",
 mentionContextCount:0,
 command: "",
 expertId: "",
 recommendId: "",
 skillId: "",
 skillCount:0,
 totalCount:0,
 fileUri: "",
 presentAt: now,
 traceId: "",
 rootRequestId: requestId,
 parentConversationId: conversationId,
 agentName: "default",
 agentType: "conversation",
 userId: account.uid,
 }
}

function asNumber(value: unknown): number | undefined {
 if (typeof value === "number" && Number.isFinite(value)) return value
 if (typeof value === "string" && value.trim()) {
 const parsed = Number(value)
 if (Number.isFinite(parsed)) return parsed
 }
 return undefined
}

function asProgress(progress: unknown, key: string): number | undefined {
 if (!progress || typeof progress !== "object") return undefined
 const record = progress as Record<string, unknown>
 return asNumber(record[key])
}

function formatDateTime(value: Date) {
 const pad = (number: number) => String(number).padStart(2, "0")
 const date = `${value.getFullYear()}-${pad(value.getMonth() +1)}-${pad(value.getDate())}`
 const time = `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
 return `${date} ${time}`
}
