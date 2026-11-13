import "server-only"

import { mkdir, readFile, rename, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { hotSwitchDataDir } from "@/lib/server/state-store"
import { parseWorkbuddyAccount, type WorkbuddyAccount } from "./account"
import {
  activeRateLimitOf,
  availableUidOf,
  nextAvailableUidOf,
  preferredRateLimitOf,
  pruneExpiredRateLimits,
  type WorkbuddyAccountRateLimit,
} from "./pool-selection"
import { WorkbuddyRateLimitError } from "./rate-limit"

/**
 * WorkBuddy 号池存储。
 *
 * 本机账号（桌面端登录态）始终存在，作为池里的第0 个账号。
 *额外账号以 JSON 文件形式放在数据目录 `workbuddy-pool/` 下，命名 `<uid>.json`。
 *每个文件就是从桌面端导出的原始凭据（和 `workbuddy-desktop.info` 同格式），
 * 解析复用 `parseWorkbuddyAccount`，不需要另造格式。
 */

export interface WorkbuddyPoolEntry {
 /**账号唯一标识（uid），本机账号固定 `local`。 */
 uid: string
 /**展示名称（昵称，可能为空）。 */
 nickname: string
 /** 来源：`local` = 本机桌面端，`file` = 号池目录文件。 */
 source: "local" | "file"
 /**凭据文件路径（file 来源才有）。 */
 filePath?: string
 /** 是否已禁用（禁用后不参与自动化和轮转）。 */
 disabled: boolean
}

export interface WorkbuddyPoolState {
 version:1
 entries: WorkbuddyPoolEntry[]
 /**
 * 当前生效账号（uid）：代理转发出站时用它的登录态。
 *
 * 用户可手动指定；上游返回账号级频率限制时，代理会自动切到下一个可用账号。
 * 缺失、或指向已从池里移除的账号时，按池顺序回落到第一个可用账号。
 */
 activeUid?: string
 /** 上游账号级限频冻结，key 为 uid，到期后自动恢复。 */
 rateLimits?: Record<string, WorkbuddyAccountRateLimit>
}

function poolDir() {
 return join(hotSwitchDataDir(), "workbuddy-pool")
}

function poolStatePath() {
 return join(poolDir(), "pool.json")
}

function emptyPoolState(): WorkbuddyPoolState {
 return { version:1, entries: [] }
}

let writeQueue: Promise<unknown> = Promise.resolve()

function enqueueMutation<T>(task: () => Promise<T>) {
 const run = writeQueue.catch(() => undefined).then(task)
 writeQueue = run.then(
   () => undefined,
   () => undefined,
 )
 return run
}

async function ensurePoolDir() {
 await mkdir(poolDir(), { recursive: true })
}

export async function readPoolState(): Promise<WorkbuddyPoolState> {
 try {
 const raw = await readFile(poolStatePath(), "utf8")
 const parsed = JSON.parse(raw) as WorkbuddyPoolState
 if (parsed.version !==1 || !Array.isArray(parsed.entries)) {
 return emptyPoolState()
 }
 return {
   ...parsed,
   ...(parsed.rateLimits &&
   typeof parsed.rateLimits === "object" &&
   !Array.isArray(parsed.rateLimits)
     ? { rateLimits: parsed.rateLimits }
     : {}),
 }
 } catch {
 return emptyPoolState()
 }
}

export async function writePoolState(state: WorkbuddyPoolState) {
 await ensurePoolDir()
 const tempPath = `${poolStatePath()}.${process.pid}.${Date.now()}.tmp`
 await writeFile(tempPath, `${JSON.stringify(state, null,2)}\n`, "utf8")
 await rename(tempPath, poolStatePath())
}

/**本机账号的固定 uid（桌面端登录态）。 */
export const LOCAL_POOL_UID = "local"

/**
 * 服务器部署用 `CODEX_HOT_SWITCH_LOCAL_WORKBUDDY=0` 关闭本机落档，
 * 避免全部导入账号不可用时错误回落到服务器上不存在的桌面端登录态。
 */
export function localWorkbuddyPoolEnabled() {
 return process.env.CODEX_HOT_SWITCH_LOCAL_WORKBUDDY !== "0"
}

function localEntry(): WorkbuddyPoolEntry | null {
 if (!localWorkbuddyPoolEnabled()) return null
 return {
   uid: LOCAL_POOL_UID,
   nickname: "",
   source: "local",
   disabled: false,
 }
}

/**列出池里所有账号；本机落档开启时始终在第一位。 */
export async function listPoolEntries(): Promise<WorkbuddyPoolEntry[]> {
 const state = await readPoolState()
 const local = localEntry()
 return local ? [local, ...state.entries] : state.entries
}

function orderedEntries(state: WorkbuddyPoolState): WorkbuddyPoolEntry[] {
 const local = localEntry()
 return local ? [local, ...state.entries] : state.entries
}

/** 当前真正可用于上游请求的 uid；全部禁用或限频时返回 undefined。 */
export function availableUidOfState(
 state: WorkbuddyPoolState,
 now = Date.now(),
) {
 return availableUidOf(state, orderedEntries(state), now)
}

/** 当前账号不可用后，按池顺序选择下一个未禁用、未限频账号。 */
export function nextAvailableUidAfter(
 state: WorkbuddyPoolState,
 uid: string,
 now = Date.now(),
) {
 return nextAvailableUidOf(state, orderedEntries(state), uid, now)
}

export function preferredRateLimitOfState(
 state: WorkbuddyPoolState,
 now = Date.now(),
) {
 return preferredRateLimitOf(state, orderedEntries(state), now)
}

/**
 * 从池状态里解出**真正可用**的激活 uid。
 *
 * 显式选中的账号可用时优先；否则按池顺序找第一个未禁用、未限频的账号。
 * 这个函数只用于界面状态；真正转发前使用 `availableUidOfState` 再确认。
 */
export function activeUidOf(state: WorkbuddyPoolState, now = Date.now()) {
 const entries = orderedEntries(state)
 return availableUidOf(state, entries, now) ?? ""
}

/** 读取真正可转发的 uid，跳过已禁用和仍在限频冻结期内的账号。 */
export async function readActiveUid(): Promise<string> {
 const state = await readPoolState()
 const uid = availableUidOfState(state)
 if (uid) return uid
 const rateLimit = preferredRateLimitOfState(state)
 if (rateLimit) throw new WorkbuddyRateLimitError(rateLimit)
 throw new Error("WorkBuddy 号池里没有可用账号")
}

/**
 * 冻结上游刚返回限频的账号，并立即把转发出口切到下一个可用账号。
 * 没有下一个可用账号时保留原选择，返回 undefined。
 */
export async function freezePoolAccount(
 uid: string,
 rateLimit: WorkbuddyAccountRateLimit,
 now = Date.now(),
) {
 return enqueueMutation(async () => {
   const state = await readPoolState()
   pruneExpiredRateLimits(state, now)
   state.rateLimits = {
     ...(state.rateLimits ?? {}),
     [uid]: rateLimit,
   }
   const nextUid = nextAvailableUidAfter(state, uid, now)
   if (nextUid) state.activeUid = nextUid
   await writePoolState(state)
   return nextUid
 })
}

/**
 * 切换当前转发账号。
 *
 * 传 `local` 表示切回本机桌面端登录态。上游限频触发的自动换号由
 * `freezePoolAccount` 负责，用户手动选择仍走这里。
 */
export async function setActivePoolAccount(uid: string) {
 const state = await readPoolState()
 const target = uid.trim() || (localWorkbuddyPoolEnabled() ? LOCAL_POOL_UID : "")
 if (target === LOCAL_POOL_UID && !localWorkbuddyPoolEnabled()) {
   throw new Error("服务器模式没有本机 WorkBuddy 登录态，请选择导入账号")
 }
 if (target && target !== LOCAL_POOL_UID) {
 const entry = state.entries.find((candidate) => candidate.uid === target)
 if (!entry) throw new Error(`号池里没有 uid=${target} 的账号`)
 if (entry.disabled) throw new Error(`账号 ${entry.nickname || target} 已禁用，请先启用再切换`)
 }
 if (target) {
   const rateLimit = activeRateLimitOf(state, target)
   if (rateLimit) {
     throw new Error(
       `账号 ${target === LOCAL_POOL_UID ? "本机账号" : target} 当前限频中，请在 ${rateLimit.resetAt} 后重试`,
     )
   }
 }
 if (target) state.activeUid = target
 else delete state.activeUid
 await writePoolState(state)
 return target
}

/**
 * 把一段凭据 JSON 文本导入号池。
 *
 * 解析成功后按 uid存文件（同 uid覆盖旧文件）；返回导入后的条目。
 */
export async function importPoolAccount(raw: string): Promise<WorkbuddyPoolEntry> {
 const account = await parseWorkbuddyAccount(raw, "<import>")
 if (!account.uid) throw new Error("导入的凭据缺少 uid，无法加入号池")
 await ensurePoolDir()
 const filePath = join(poolDir(), `${account.uid}.json`)
 const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
 await writeFile(tempPath, raw, "utf8")
 await rename(tempPath, filePath)

 const state = await readPoolState()
 const existing = state.entries.find((entry) => entry.uid === account.uid)
 const entry: WorkbuddyPoolEntry = {
 uid: account.uid,
 nickname: account.nickname,
 source: "file",
 filePath,
 disabled: existing?.disabled ?? false,
 }
 if (existing) {
 Object.assign(existing, entry)
 } else {
 state.entries.push(entry)
 }
 await writePoolState(state)
 return entry
}

export async function removePoolAccount(uid: string) {
 if (uid === "local") throw new Error("本机账号不能从号池移除")
 const state = await readPoolState()
 const before = state.entries.length
 state.entries = state.entries.filter((entry) => entry.uid !== uid)
 if (state.entries.length === before) return
 if (state.rateLimits) delete state.rateLimits[uid]
 // 删掉的正是当前转发账号时清掉标记，回落本机账号。
 if (state.activeUid === uid) delete state.activeUid
 await writePoolState(state)
 const filePath = join(poolDir(), `${uid}.json`)
 try {
 await (await import("node:fs/promises")).unlink(filePath)
 } catch {
 //凭据文件可能已不存在，移除池条目就算完成。
 }
}

export async function setPoolAccountDisabled(uid: string, disabled: boolean) {
 const state = await readPoolState()
 const entry = state.entries.find((candidate) => candidate.uid === uid)
 if (!entry) throw new Error(`号池里没有 uid=${uid} 的账号`)
 entry.disabled = disabled
 // 禁用的账号不能继续当转发出口：清掉激活标记，自动回落本机账号。
 if (disabled && state.activeUid === uid) delete state.activeUid
 await writePoolState(state)
}

/**读取某个账号的登录态（local →桌面端文件；file → 号池目录）。 */
export async function readPoolAccount(uid: string): Promise<WorkbuddyAccount> {
 if (uid === "local") {
   if (!localWorkbuddyPoolEnabled()) {
     throw new Error("服务器模式没有本机 WorkBuddy 登录态，请使用号池里的导入账号")
   }
 const { readWorkbuddyAccount } = await import("./account")
 return readWorkbuddyAccount()
 }
 const state = await readPoolState()
 const entry = state.entries.find((candidate) => candidate.uid === uid)
 if (!entry?.filePath) throw new Error(`号池里没有 uid=${uid} 的账号`)
 const { readFile: readFileFn } = await import("node:fs/promises")
 const raw = await readFileFn(entry.filePath, "utf8")
 return parseWorkbuddyAccount(raw, entry.filePath)
}

/**扫号池目录下还没登记进 pool.json 的凭据文件（手工拷贝进来的场景）。 */
export async function syncPoolFromDisk(): Promise<number> {
 await ensurePoolDir()
 const files = (await readdir(poolDir())).filter(
   (name) =>
     name.endsWith(".json") &&
     name !== "pool.json" &&
     name !== "daily-schedule.json",
 )
 if (!files.length) return 0
 const state = await readPoolState()
 const known = new Set(state.entries.map((entry) => entry.uid))
 let added =0
 for (const name of files) {
 const filePath = join(poolDir(), name)
 try {
 const raw = await readFile(filePath, "utf8")
 const account = await parseWorkbuddyAccount(raw, filePath)
 if (account.uid && !known.has(account.uid)) {
 state.entries.push({
 uid: account.uid,
 nickname: account.nickname,
 source: "file",
 filePath,
 disabled: false,
 })
 added++
 }
 } catch {
 // 不合法的凭据文件跳过，不让一个坏文件拖垮整个池。
 }
 }
 if (added) await writePoolState(state)
 return added
}
