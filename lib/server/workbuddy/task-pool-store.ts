import "server-only"

import { mkdir, readFile, rename, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { hotSwitchDataDir } from "@/lib/server/state-store"
import {
  parseWorkbuddyAccount,
  WorkbuddyCredentialExpiredError,
  type WorkbuddyAccount,
} from "./account"
import { renewCnPoolAccount, shouldRenewCnAccount } from "./cn-token-renewal"
import { WorkbuddyCnRefreshError } from "./cn-oauth"
import type { WorkbuddyAccountBan } from "./account-ban"
import {
  accountBanOf,
  activeRateLimitOf,
  availableUidOf,
  credentialFailureOf,
  preferredRateLimitOf,
  pruneExpiredRateLimits,
  selectableUidsAfter,
  selectableUidsOf,
  type WorkbuddyAccountRateLimit,
  type WorkbuddyAccountCredentialFailure,
} from "./pool-selection"
import {
  firstReadableAccount,
  firstReadableUid,
  type ReadablePoolAccount,
} from "./pool-probe"
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
 /**
  * 凭据文件定位只用 uid，不持久化绝对路径。
  *
  * 账号隔离改造后数据目录会迁移（例如由共享目录改为 `accounts/<id>/`），
  * 存下来的绝对路径会立刻失效，签到会以 ENOENT 静默失败一整天。
  */
 fileName?: string
 /** 总开关：禁用后既不参与转发，也不参与自动化。 */
 disabled: boolean
 /**
  * 单独的转发开关。undefined = 启用；`false` = 只领积分、不占转发出口。
  *
  * 与 `disabled` 并存而不是取代它：总开关用来"整个停用"，这两个细开关
  * 用来表达"转发和自动化只做其一"。缺省一律视为启用，老数据不用迁移。
  */
 relayEnabled?: boolean
 /** 单独的自动化开关。undefined = 启用；`false` = 只转发、不自动签到。 */
 automationEnabled?: boolean
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
 /** 上游返回 11140 后持久封禁，只能由操作者手动解除。 */
 accountBans?: Record<string, WorkbuddyAccountBan>
  /** refreshToken 已被上游撤销；重新授权或重新导入后清除。 */
  credentialFailures?: Record<string, WorkbuddyAccountCredentialFailure>
}

function poolDir() {
 return join(hotSwitchDataDir(), "workbuddy-pool")
}

function poolStatePath() {
 return join(poolDir(), "pool.json")
}

/**
 * 凭据文件位置只由**当前**号池目录和 uid 推导，不读历史绝对路径。
 *
 * 这样账号目录整体迁移（共享目录 → accounts/<id>/）后不需要修数据，
 * 也不会因为一个过期的 filePath 让整天的签到全部 ENOENT。
 */
function accountFilePath(uid: string) {
 return join(poolDir(), `${uid}.json`)
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
   ...(parsed.accountBans &&
   typeof parsed.accountBans === "object" &&
   !Array.isArray(parsed.accountBans)
     ? { accountBans: parsed.accountBans }
     : {}),
   ...(parsed.credentialFailures &&
   typeof parsed.credentialFailures === "object" &&
   !Array.isArray(parsed.credentialFailures)
     ? { credentialFailures: parsed.credentialFailures }
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

/**
 * 当前池状态里**允许尝试**的候选 uid，按尝试顺序排列。
 *
 * 只做禁用/封禁/限频过滤；登录态是否过期要读盘才知道，转发链路按这个顺序逐个探测。
 */
export function selectableUidsOfState(
  state: WorkbuddyPoolState,
  now = Date.now(),
) {
  return selectableUidsOf(state, orderedEntries(state), now)
}

/** `uid` 之后允许尝试的候选账号（末尾回绕）。 */
export function selectableUidsAfterState(
  state: WorkbuddyPoolState,
  uid: string,
  now = Date.now(),
) {
  return selectableUidsAfter(state, orderedEntries(state), uid, now)
}

/** 当前真正可用于上游请求的 uid；全部禁用、封禁或限频时返回 undefined。 */
export function availableUidOfState(
 state: WorkbuddyPoolState,
 now = Date.now(),
) {
 return availableUidOf(state, orderedEntries(state), now)
}

/**
 * `uid` 之后第一个**能读出未过期登录态**的账号。
 *
 * 号池状态里看不出过期，必须读盘；轮换时用它，避免把出口切到另一个
 * 必然 502 的过期账号。
 */
export async function nextReadablePoolUidAfter(uid: string) {
  return firstReadableUid(
    selectableUidsAfterState(await readPoolState(), uid),
    readPoolAccount,
  )
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
 * 显式选中的账号可用时优先；否则按池顺序找第一个未禁用、未封禁、未限频的账号。
 * 这个函数只用于界面状态；真正转发前使用 `availableUidOfState` 再确认。
 */
export function activeUidOf(state: WorkbuddyPoolState, now = Date.now()) {
 return availableUidOfState(state, now) ?? ""
}

/**
 * 读出当前可转发的账号（uid + 登录态），跳过禁用、封禁、限频和**登录态已过期**的账号。
 *
 * 过期判断只能读盘确认：一个号过期时自动跳到池里下一个未过期账号，
 * 所以界面上「设为转发」的账号过期后不会把整条转发链路卡死。
 */
export async function readActivePoolAccount(): Promise<ReadablePoolAccount<WorkbuddyAccount>> {
  const state = await readPoolState()
  const candidates = selectableUidsOfState(state)
  if (candidates.length === 0) {
    const rateLimit = preferredRateLimitOfState(state)
    if (rateLimit) throw new WorkbuddyRateLimitError(rateLimit)
    throw new Error("WorkBuddy 号池里没有可用账号")
  }
  return firstReadableAccount(candidates, readPoolAccount)
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
   // 换号还要排除登录态过期的账号，否则会把出口切到另一个必然失败的号上。
   const nextUid = await firstReadableUid(
     selectableUidsAfterState(state, uid, now),
     readPoolAccount,
   )
   if (nextUid) state.activeUid = nextUid
   await writePoolState(state)
   return nextUid
 })
}

/** 持久封禁账号；不清除手动禁用、限频等其他状态。 */
export async function banPoolAccount(
  uid: string,
  ban: WorkbuddyAccountBan,
) {
  return enqueueMutation(async () => {
    const state = await readPoolState()
    state.accountBans = {
      ...(state.accountBans ?? {}),
      [uid]: ban,
    }
    if (state.activeUid === uid) delete state.activeUid
    await writePoolState(state)
  })
}

/** 仅在操作者明确解除封禁并重新启用时调用。 */
export async function unbanPoolAccount(uid: string) {
  return enqueueMutation(async () => {
    const state = await readPoolState()
    const wasBanned = Boolean(state.accountBans?.[uid])
    if (state.accountBans) delete state.accountBans[uid]
    if (uid !== LOCAL_POOL_UID) {
      const entry = state.entries.find((candidate) => candidate.uid === uid)
      if (!entry) throw new Error(`号池里没有 uid=${uid} 的账号`)
      entry.disabled = false
    }
    if (!wasBanned) return false
    await writePoolState(state)
    return true
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
 const ban = accountBanOf(state, target)
 if (ban) {
   throw new Error(`账号 ${target === LOCAL_POOL_UID ? "本机账号" : target} 已被上游封禁，请先解除封禁`)
 }
  const credentialFailure = credentialFailureOf(state, target)
  if (credentialFailure) {
    throw new Error(
      `账号 ${target === LOCAL_POOL_UID ? "本机账号" : target} 登录态已失效，请重新授权登录`,
    )
  }
 if (target && target !== LOCAL_POOL_UID) {
 const entry = state.entries.find((candidate) => candidate.uid === target)
 if (!entry) throw new Error(`号池里没有 uid=${target} 的账号`)
 if (entry.disabled) throw new Error(`账号 ${entry.nickname || target} 已禁用，请先启用再切换`)
 }
 if (target) {
   const rateLimit = activeRateLimitOf(state, target)
   if (rateLimit) {
     const resetAt =
       typeof rateLimit.resetAt === "string" && rateLimit.resetAt.trim()
         ? `，请在 ${rateLimit.resetAt} 后重试`
         : ""
     throw new Error(
       `账号 ${target === LOCAL_POOL_UID ? "本机账号" : target} 当前${
         rateLimit.kind === "quota_exhausted" ? "额度已用尽" : "限频中"
       }${resetAt}`,
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
 fileName: `${account.uid}.json`,
 disabled: existing?.disabled ?? false,
 }
 if (existing) {
 Object.assign(existing, entry)
 } else {
 state.entries.push(entry)
 }
 if (state.credentialFailures) delete state.credentialFailures[account.uid]
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
 if (state.accountBans) delete state.accountBans[uid]
 if (state.credentialFailures) delete state.credentialFailures[uid]
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

/** 持久记录 refreshToken 已被上游撤销；重新授权或重新导入后清除。 */
export async function markPoolAccountCredentialFailure(
  uid: string,
  failure: WorkbuddyAccountCredentialFailure,
) {
  return enqueueMutation(async () => {
    const state = await readPoolState()
    state.credentialFailures = {
      ...(state.credentialFailures ?? {}),
      [uid]: failure,
    }
    if (state.activeUid === uid) delete state.activeUid
    await writePoolState(state)
  })
}

/**
 * 单独设置转发 / 自动化开关。
 *
 * 两个字段都是"缺省即启用"，所以只在关闭时写 `false`、开启时删掉字段，
 * 让 pool.json 保持干净、也能和老版本互相读懂。
 */
export async function setPoolAccountToggles(
  uid: string,
  toggles: { relayEnabled?: boolean; automationEnabled?: boolean },
) {
  const state = await readPoolState()
  const entry = state.entries.find((candidate) => candidate.uid === uid)
  if (!entry) throw new Error(`号池里没有 uid=${uid} 的账号`)

  if (toggles.relayEnabled !== undefined) {
    if (toggles.relayEnabled) delete entry.relayEnabled
    else entry.relayEnabled = false
  }
  if (toggles.automationEnabled !== undefined) {
    if (toggles.automationEnabled) delete entry.automationEnabled
    else entry.automationEnabled = false
  }

  // 关掉转发后它不能再当出口，激活标记要清掉，由调用方回落到下一个可用账号。
  if (entry.relayEnabled === false && state.activeUid === uid) delete state.activeUid

  await writePoolState(state)
}

/**读取某个账号的登录态（local →桌面端文件；file → 号池目录）。 */
export async function readPoolAccount(uid: string): Promise<WorkbuddyAccount> {
 const state = await readPoolState()
 const ban = accountBanOf(state, uid)
 if (ban) {
   throw new Error(`账号已被上游封禁：${ban.message}`)
 }
 const credentialFailure = credentialFailureOf(state, uid)
 if (credentialFailure) {
   throw new Error(`账号登录态已失效：${credentialFailure.message}`)
 }
 if (uid === "local") {
   if (!localWorkbuddyPoolEnabled()) {
     throw new Error("服务器模式没有本机 WorkBuddy 登录态，请使用号池里的导入账号")
   }
 const { readWorkbuddyAccount } = await import("./account")
 return readWorkbuddyAccount()
 }
 const entry = state.entries.find((candidate) => candidate.uid === uid)
 if (!entry) throw new Error(`号池里没有 uid=${uid} 的账号`)
 const filePath = accountFilePath(uid)
 const { readFile: readFileFn } = await import("node:fs/promises")
 const raw = await readFileFn(filePath, "utf8")

 let account: WorkbuddyAccount
 try {
   account = await parseWorkbuddyAccount(raw, filePath)
 } catch (error) {
   if (!(error instanceof WorkbuddyCredentialExpiredError)) throw error
   // 已过期：先尝试用 refreshToken 续期，续不上再把「过期」这个真实原因抛回去。
   const expired = await parseWorkbuddyAccount(raw, filePath, { allowExpired: true })
  // 当天已经试过就不再打上游（token 已死时这才是唯一结局）。
  if (!shouldRenewCnAccount(expired)) throw error
   try {
     return await renewCnPoolAccount({ uid, filePath, raw, account: expired })
   } catch (renewError) {
     // refreshToken 被上游判死时，能做的只有回桌面端重新登录——把这个结论直说，
     // 不要把内部错误码当成最终文案抛给调用方。
     if (
       renewError instanceof WorkbuddyCnRefreshError &&
       renewError.deadToken
     ) {
       await markPoolAccountCredentialFailure(uid, {
         code: 12153,
         message: renewError.message,
         detectedAt: new Date().toISOString(),
       })
       throw new Error(
         `账号登录态已失效：${renewError.message}。请重新授权登录`,
       )
     }
     throw renewError
   }
 }

 if (!shouldRenewCnAccount(account)) return account
 try {
   return await renewCnPoolAccount({ uid, filePath, raw, account })
 } catch (error) {
   // 网络抖动时旧 token 仍可能有效；只有上游明确撤销 refreshToken 才判登录态失效。
   if (
     error instanceof WorkbuddyCnRefreshError &&
     !error.deadToken
   ) {
     return account
   }
   if (error instanceof WorkbuddyCnRefreshError && error.deadToken) {
     await markPoolAccountCredentialFailure(uid, {
       code: 12153,
       message: error.message,
       detectedAt: new Date().toISOString(),
     })
     throw new Error(
       `账号登录态已失效：${error.message}。请重新授权登录`,
     )
   }
   throw error
 }
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
  let repaired = 0
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
 fileName: name,
 disabled: false,
 })
 added++
 }
 } catch {
 // 不合法的凭据文件跳过，不让一个坏文件拖垮整个池。
 }
 }
  // 旧版本把绝对路径写进 pool.json，目录一迁移就全部失效；这里按 uid 就地修正。
  for (const entry of state.entries) {
    if (entry.source !== "file") continue
    const expected = `${entry.uid}.json`
    const legacyPath = (entry as { filePath?: unknown }).filePath
    if (entry.fileName === expected && legacyPath === undefined) continue
    entry.fileName = expected
    delete (entry as { filePath?: unknown }).filePath
    repaired++
  }
  if (added || repaired) await writePoolState(state)
 return added
}
