import "server-only"

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { hotSwitchDataDir } from "@/lib/server/state-store"
import type { WorkbuddyAccount } from "./account"
import type { WorkbuddyAccountBan } from "./account-ban"
import { parseGlobalCredential } from "./global-account"
import { isSafeGlobalUid } from "./global-oauth"
import {
  accountBanOf,
  availableUidOf,
  nextAvailableUidOf,
  preferredRateLimitOf,
  pruneExpiredRateLimits,
  type WorkbuddyAccountRateLimit,
} from "./pool-selection"
import { WorkbuddyRateLimitError } from "./rate-limit"

/**
 * WorkBuddy **国际版**号池存储（独立于国内站号池）。
 *
 * 与国内站号池的差别：
 * - 没有「本机账号」这一档——国际版账号全部由本页授权登录或手工导入产生；
 * - 目录独立放在 `workbuddy-global-pool/`，与国内站 `workbuddy-pool/` 互不影响；
 * - 凭据支持 refreshToken 续期，读出来时会自动刷新并回写。
 *
 * 每个账号一个 `<uid>.json`，内容就是桌面端 `workbuddy-desktop.info` 同格式。
 */

export interface GlobalPoolEntry {
  uid: string
  nickname: string
  domain: string
  filePath?: string
  disabled: boolean
}

export interface GlobalPoolState {
  version: 1
  entries: GlobalPoolEntry[]
  /**
   * 当前生效账号（uid）：转发到国际站时用它的登录态。
   *
   * 用户可手动指定；上游返回账号级频率限制时，代理会自动切到下一个可用账号。
   * 缺失、或指向已移除/已禁用的账号时，回落到池里第一个可用账号。
   */
  activeUid?: string
  /** 上游账号级限频冻结，key 为 uid，到期后自动恢复。 */
  rateLimits?: Record<string, WorkbuddyAccountRateLimit>
  /** 上游返回 11140 后持久封禁，只能由操作者手动解除。 */
  accountBans?: Record<string, WorkbuddyAccountBan>
}

function emptyPoolState(): GlobalPoolState {
  return { version: 1, entries: [] }
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

export function globalPoolDir() {
  return join(hotSwitchDataDir(), "workbuddy-global-pool")
}

function poolStatePath() {
  return join(globalPoolDir(), "pool.json")
}

function entryFilePath(uid: string) {
  if (!isSafeGlobalUid(uid)) {
    throw new Error(`uid 含非法字符，拒绝落盘（防路径穿越）：${uid}`)
  }
  return join(globalPoolDir(), `${uid}.json`)
}

async function ensurePoolDir() {
  await mkdir(globalPoolDir(), { recursive: true })
}

export async function readGlobalPoolState(): Promise<GlobalPoolState> {
  try {
    const raw = await readFile(poolStatePath(), "utf8")
    const parsed = JSON.parse(raw) as GlobalPoolState
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
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
    }
  } catch {
    return emptyPoolState()
  }
}

export async function writeGlobalPoolState(state: GlobalPoolState) {
  await ensurePoolDir()
  const target = poolStatePath()
  const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(tempPath, target)
}

export async function listGlobalPoolEntries(): Promise<GlobalPoolEntry[]> {
  return (await readGlobalPoolState()).entries
}

/**
 * 解出国际版号池**真正可用**的生效 uid。
 *
 * 国际站没有「本机账号」这一档，所以回落规则与国内站不同：
 * 1. 显式选中且账号存在、未禁用、未封禁、未限频 → 用它；
 * 2. 否则池里第一个未禁用、未封禁、未限频账号；
 * 3. 池里没有可用账号 → 抛错（转发链路会把这个原因原样抛给用户）。
 *
 * 代理链路每次请求都会调用，所以这里只做纯计算，不做 IO。
 */
export function availableGlobalUidOf(
  state: GlobalPoolState,
  now = Date.now(),
) {
  return availableUidOf(state, state.entries, now)
}

export function activeGlobalUidOf(
  state: GlobalPoolState,
  now = Date.now(),
): string {
  const available = availableGlobalUidOf(state, now)
  if (available) return available
  const rateLimit = preferredRateLimitOfGlobalState(state, now)
  if (rateLimit) throw new WorkbuddyRateLimitError(rateLimit)
  throw new Error("国际版号池里没有可用账号，请先在「WorkBuddy 国际版号池」里授权登录或导入账号")
}

export function nextAvailableGlobalUidAfter(
  state: GlobalPoolState,
  uid: string,
  now = Date.now(),
) {
  return nextAvailableUidOf(state, state.entries, uid, now)
}

export function preferredRateLimitOfGlobalState(
  state: GlobalPoolState,
  now = Date.now(),
) {
  return preferredRateLimitOf(state, state.entries, now)
}

/** 读取当前生效的国际版账号 uid。 */
export async function readActiveGlobalUid(): Promise<string> {
  return activeGlobalUidOf(await readGlobalPoolState())
}

/**
 * 指定转发用哪个国际版账号（「设为转发账号」）。
 *
 * 传空串表示清掉显式选择，回落到池里第一个未禁用账号。
 */
export async function setActiveGlobalPoolAccount(uid: string) {
  const state = await readGlobalPoolState()
  const target = uid.trim()
  if (target) {
    const entry = state.entries.find((candidate) => candidate.uid === target)
    if (!entry) throw new Error(`国际版号池里没有 uid=${target} 的账号`)
    if (accountBanOf(state, target)) {
      throw new Error(`账号 ${entry.nickname || target} 已被上游封禁，请先解除封禁`)
    }
    if (entry.disabled) throw new Error(`账号 ${entry.nickname || target} 已禁用，请先启用再切换`)
    state.activeUid = target
  } else {
    delete state.activeUid
  }
  await writeGlobalPoolState(state)
  return target
}

/**
 * 读取当前生效账号的登录态。
 *
 * 这是国际站转发链路的凭据入口：`withWorkbuddyCredentials` 在 realm 为 `global`
 * 时走这里，等价于国内站的 `readActivePoolAccount`。
 */
export async function readActiveGlobalPoolAccount(): Promise<WorkbuddyAccount> {
  return readGlobalPoolAccount(await readActiveGlobalUid())
}

/**
 * 冻结上游刚返回限频的国际版账号，并立即切到下一个可用账号。
 * 没有下一个可用账号时保留原选择，返回 undefined。
 */
export async function freezeGlobalPoolAccount(
  uid: string,
  rateLimit: WorkbuddyAccountRateLimit,
  now = Date.now(),
) {
  return enqueueMutation(async () => {
    const state = await readGlobalPoolState()
    pruneExpiredRateLimits(state, now)
    state.rateLimits = {
      ...(state.rateLimits ?? {}),
      [uid]: rateLimit,
    }
    const nextUid = nextAvailableGlobalUidAfter(state, uid, now)
    if (nextUid) state.activeUid = nextUid
    await writeGlobalPoolState(state)
    return nextUid
  })
}

/** 持久封禁国际版账号；不自动解除，也不尝试同池其他账号。 */
export async function banGlobalPoolAccount(
  uid: string,
  ban: WorkbuddyAccountBan,
) {
  return enqueueMutation(async () => {
    const state = await readGlobalPoolState()
    state.accountBans = {
      ...(state.accountBans ?? {}),
      [uid]: ban,
    }
    if (state.activeUid === uid) delete state.activeUid
    await writeGlobalPoolState(state)
  })
}

export async function unbanGlobalPoolAccount(uid: string) {
  return enqueueMutation(async () => {
    const state = await readGlobalPoolState()
    const wasBanned = Boolean(state.accountBans?.[uid])
    if (state.accountBans) delete state.accountBans[uid]
    const entry = state.entries.find((candidate) => candidate.uid === uid)
    if (!entry) throw new Error(`国际版号池里没有 uid=${uid} 的账号`)
    entry.disabled = false
    if (!wasBanned) return false
    await writeGlobalPoolState(state)
    return true
  })
}

/**
 * 导入一段凭据文本到国际版号池。
 *
 * 解析成功按 uid 存文件（同 uid 覆盖旧文件）；`refresh: false` 表示只做静态解析，
 * 不在导入阶段打上游（导入时上游可能还没准备好，避免把导入卡死）。
 */
export async function importGlobalAccount(raw: string): Promise<GlobalPoolEntry> {
  const parsed = await parseGlobalCredential(raw, "<import>", { refresh: false })
  const uid = parsed.account.uid
  if (!uid) {
    throw new Error("凭据缺少 uid，无法加入国际版号池（请用页面上的授权登录，或导入带 uid 的凭据）")
  }
  await ensurePoolDir()
  const filePath = entryFilePath(uid)
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, raw, "utf8")
  await rename(tempPath, filePath)

  const state = await readGlobalPoolState()
  const existing = state.entries.find((entry) => entry.uid === uid)
  const entry: GlobalPoolEntry = {
    uid,
    nickname: parsed.account.nickname,
    domain: parsed.account.domain,
    filePath,
    disabled: existing?.disabled ?? false,
  }
  if (existing) Object.assign(existing, entry)
  else state.entries.push(entry)
  await writeGlobalPoolState(state)
  return entry
}

export async function removeGlobalAccount(uid: string) {
  const state = await readGlobalPoolState()
  const before = state.entries.length
  state.entries = state.entries.filter((entry) => entry.uid !== uid)
  if (state.entries.length === before) return
  if (state.rateLimits) delete state.rateLimits[uid]
  if (state.accountBans) delete state.accountBans[uid]
  // 删掉的正是当前生效账号时清掉标记，回落到池里第一个可用账号。
  if (state.activeUid === uid) delete state.activeUid
  await writeGlobalPoolState(state)
  try {
    await unlink(entryFilePath(uid))
  } catch {
    // 凭据文件可能已不存在，移除池条目就算完成。
  }
}

export async function setGlobalAccountDisabled(uid: string, disabled: boolean) {
  const state = await readGlobalPoolState()
  const entry = state.entries.find((candidate) => candidate.uid === uid)
  if (!entry) throw new Error(`国际版号池里没有 uid=${uid} 的账号`)
  entry.disabled = disabled
  // 禁用的账号不能继续当转发出口：清掉生效标记。
  if (disabled && state.activeUid === uid) delete state.activeUid
  await writeGlobalPoolState(state)
}

/**
 * 读取某个国际版账号的登录态。
 *
 * 过期或临近过期时用 refreshToken 续期，并把新 token 回写凭据文件——国际站支持
 * 续期，所以这里不需要用户反复重新登录。
 */
export async function readGlobalPoolAccount(uid: string): Promise<WorkbuddyAccount> {
  const state = await readGlobalPoolState()
  const ban = accountBanOf(state, uid)
  if (ban) {
    throw new Error(`账号已被上游封禁：${ban.message}`)
  }
  const entry = state.entries.find((candidate) => candidate.uid === uid)
  if (!entry) throw new Error(`国际版号池里没有 uid=${uid} 的账号`)
  const filePath = entry.filePath ?? entryFilePath(uid)
  // 动态路径的读写走动态 import 取 fs：静态导入的 fs.readFile(动态路径) 会让
  // Next 的文件追踪顺着路径把整个项目卷进 NFT 清单（与 task-pool-store.ts 的
  // readPoolAccount 同一约定）。
  const { readFile: readFileFn, writeFile: writeFileFn } = await import("node:fs/promises")
  const raw = await readFileFn(filePath, "utf8")
  const parsed = await parseGlobalCredential(raw, filePath)
  if (parsed.refreshed) {
    await writeFileFn(filePath, parsed.raw, "utf8").catch(() => undefined)
  }
  return parsed.account
}

/** 扫目录里还没登记进 pool.json 的凭据文件（手工拷贝进来的场景）。 */
export async function syncGlobalPoolFromDisk(): Promise<number> {
  await ensurePoolDir()
  const files = (await readdir(globalPoolDir())).filter(
    (name) => name.endsWith(".json") && name !== "pool.json",
  )
  if (!files.length) return 0
  const state = await readGlobalPoolState()
  const known = new Set(state.entries.map((entry) => entry.uid))
  // 同 readGlobalPoolAccount：动态路径读取用动态 import，避免整项目被追踪。
  const { readFile: readFileFn } = await import("node:fs/promises")
  let added = 0
  for (const name of files) {
    const filePath = join(globalPoolDir(), name)
    try {
      const raw = await readFileFn(filePath, "utf8")
      // 只做静态解析，不在同步阶段打上游。
      const parsed = await parseGlobalCredential(raw, filePath, { refresh: false })
      if (parsed.account.uid && !known.has(parsed.account.uid)) {
        state.entries.push({
          uid: parsed.account.uid,
          nickname: parsed.account.nickname,
          domain: parsed.account.domain,
          filePath,
          disabled: false,
        })
        added += 1
      }
    } catch {
      // 不合法的凭据文件跳过，不让一个坏文件拖垮整个池。
    }
  }
  if (added) await writeGlobalPoolState(state)
  return added
}
