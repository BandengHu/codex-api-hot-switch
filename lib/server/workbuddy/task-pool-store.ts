import "server-only"

import { mkdir, readFile, rename, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { hotSwitchDataDir } from "@/lib/server/state-store"
import { parseWorkbuddyAccount, type WorkbuddyAccount } from "./account"

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
 * 号池**不做自动轮转**，切号完全由用户在界面上手动决定，这里只记「选了谁」。
 * 缺失、或指向已从池里移除的账号时，一律回落本机账号 `local`。
 */
 activeUid?: string
}

function poolDir() {
 return join(hotSwitchDataDir(), "workbuddy-pool")
}

function poolStatePath() {
 return join(poolDir(), "pool.json")
}

const DEFAULT_STATE: WorkbuddyPoolState = { version:1, entries: [] }

async function ensurePoolDir() {
 await mkdir(poolDir(), { recursive: true })
}

export async function readPoolState(): Promise<WorkbuddyPoolState> {
 try {
 const raw = await readFile(poolStatePath(), "utf8")
 const parsed = JSON.parse(raw) as WorkbuddyPoolState
 if (parsed.version !==1 || !Array.isArray(parsed.entries)) return DEFAULT_STATE
 return parsed
 } catch {
 return DEFAULT_STATE
 }
}

export async function writePoolState(state: WorkbuddyPoolState) {
 await ensurePoolDir()
 const tempPath = `${poolStatePath()}.${process.pid}.${Date.now()}.tmp`
 await writeFile(tempPath, `${JSON.stringify(state, null,2)}\n`, "utf8")
 await rename(tempPath, poolStatePath())
}

/**列出池里所有账号（本机账号始终在第一位）。 */
export async function listPoolEntries(): Promise<WorkbuddyPoolEntry[]> {
 const state = await readPoolState()
 const local: WorkbuddyPoolEntry = {
 uid: "local",
 nickname: "",
 source: "local",
 disabled: false,
 }
 return [local, ...state.entries]
}

/**本机账号的固定 uid（池里永远存在，代表桌面端登录态）。 */
export const LOCAL_POOL_UID = "local"

/**
 * 从池状态里解出**真正可用**的激活 uid。
 *
 * 只有三种情况算有效：显式选中且账号存在、账号未被禁用；其余（没选过、选中的账号
 * 已删除、已禁用）一律回落本机账号。代理链路每次请求都会调用，不能抛错。
 */
export function activeUidOf(state: WorkbuddyPoolState) {
 const uid = state.activeUid?.trim()
 if (!uid || uid === LOCAL_POOL_UID) return LOCAL_POOL_UID
 const entry = state.entries.find((candidate) => candidate.uid === uid)
 if (!entry || entry.disabled) return LOCAL_POOL_UID
 return uid
}

/**读取当前生效账号的 uid（无效时回落 `local`）。 */
export async function readActiveUid(): Promise<string> {
 return activeUidOf(await readPoolState())
}

/**
 * 切换当前转发账号。
 *
 * 传 `local` 表示切回本机桌面端登录态。号池**不做自动轮转**：切号只由这里发生，
 * 即用户在界面上的手动选择。
 */
export async function setActivePoolAccount(uid: string) {
 const state = await readPoolState()
 const target = uid.trim() || LOCAL_POOL_UID
 if (target !== LOCAL_POOL_UID) {
 const entry = state.entries.find((candidate) => candidate.uid === target)
 if (!entry) throw new Error(`号池里没有 uid=${target} 的账号`)
 if (entry.disabled) throw new Error(`账号 ${entry.nickname || target} 已禁用，请先启用再切换`)
 }
 state.activeUid = target
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
 const files = (await readdir(poolDir())).filter((name) => name.endsWith(".json") && name !== "pool.json")
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
