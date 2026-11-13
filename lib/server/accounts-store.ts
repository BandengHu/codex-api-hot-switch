import "server-only"

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { sharedDataDir } from "./data-root"

/**
 * 服务器模式的多账号表。
 *
 * 账号表是全局唯一的一份，放在共享数据目录下，与各账号自己的配置目录分开：
 *
 *   {shared}/accounts.json          账号表（含密码哈希，权限 600）
 *   {shared}/accounts/{id}/         该账号的全部配置、日志与号池
 *
 * 任何账号都不能读写别人的目录，只有管理员能审批与停用账号。
 */

export type AccountRole = "admin" | "member"
export type AccountStatus = "pending" | "active" | "disabled"

export interface AccountRecord {
  id: string
  username: string
  role: AccountRole
  status: AccountStatus
  passwordSalt: string
  passwordHash: string
  createdAt: string
  updatedAt: string
  approvedAt?: string
  approvedBy?: string
}

export interface PublicAccount {
  id: string
  username: string
  role: AccountRole
  status: AccountStatus
  createdAt: string
  approvedAt?: string
}

interface AccountsFile {
  version: 1
  accounts: AccountRecord[]
}

const ACCOUNTS_FILE_VERSION = 1
const accountsWriteQueue: { current: Promise<unknown> } = {
  current: Promise.resolve(),
}

let accountsCache: AccountRecord[] | null = null

export const ACCOUNT_USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/
export const ACCOUNT_PASSWORD_MIN_LENGTH = 8
export const ACCOUNT_PASSWORD_MAX_LENGTH = 128

export function accountsFilePath() {
  return join(sharedDataDir(), "accounts.json")
}

export function accountDataDirPath(accountId: string) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(accountId)) {
    throw new Error("账号 ID 非法，拒绝拼路径")
  }
  return join(sharedDataDir(), "accounts", accountId)
}

export function normalizeUsername(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

export function validateUsername(value: unknown) {
  const username = normalizeUsername(value)
  if (!ACCOUNT_USERNAME_PATTERN.test(username)) {
    throw new Error("用户名需为 3-32 位字母、数字、下划线、点或短横线")
  }
  return username
}

export function validatePassword(value: unknown) {
  if (typeof value !== "string") throw new Error("密码格式不正确")
  if (
    value.length < ACCOUNT_PASSWORD_MIN_LENGTH ||
    value.length > ACCOUNT_PASSWORD_MAX_LENGTH
  ) {
    throw new Error(
      `密码长度需为 ${ACCOUNT_PASSWORD_MIN_LENGTH}-${ACCOUNT_PASSWORD_MAX_LENGTH} 位`,
    )
  }
  return value
}

function normalizeAccount(value: unknown): AccountRecord | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Partial<AccountRecord>
  if (
    typeof raw.id !== "string" ||
    typeof raw.username !== "string" ||
    typeof raw.passwordSalt !== "string" ||
    typeof raw.passwordHash !== "string"
  ) {
    return null
  }
  const role: AccountRole = raw.role === "admin" ? "admin" : "member"
  const status: AccountStatus =
    raw.status === "active" || raw.status === "disabled" ? raw.status : "pending"
  return {
    id: raw.id,
    username: normalizeUsername(raw.username),
    role,
    status,
    passwordSalt: raw.passwordSalt,
    passwordHash: raw.passwordHash,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    ...(typeof raw.approvedAt === "string" ? { approvedAt: raw.approvedAt } : {}),
    ...(typeof raw.approvedBy === "string" ? { approvedBy: raw.approvedBy } : {}),
  }
}

export async function readAccounts(): Promise<AccountRecord[]> {
  if (accountsCache) return accountsCache
  try {
    const raw = await readFile(accountsFilePath(), "utf8")
    const parsed = JSON.parse(raw) as Partial<AccountsFile>
    accountsCache = Array.isArray(parsed.accounts)
      ? parsed.accounts
          .map(normalizeAccount)
          .filter((account): account is AccountRecord => Boolean(account))
      : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    accountsCache = []
  }
  return accountsCache
}

async function writeAccounts(accounts: AccountRecord[]) {
  const path = accountsFilePath()
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  const value: AccountsFile = { version: ACCOUNTS_FILE_VERSION, accounts }
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
  await rename(tempPath, path)
  accountsCache = accounts
}

async function enqueueAccountsMutation<T>(task: () => Promise<T>): Promise<T> {
  const run = accountsWriteQueue.current.catch(() => undefined).then(task)
  accountsWriteQueue.current = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function toPublicAccount(account: AccountRecord): PublicAccount {
  return {
    id: account.id,
    username: account.username,
    role: account.role,
    status: account.status,
    createdAt: account.createdAt,
    ...(account.approvedAt ? { approvedAt: account.approvedAt } : {}),
  }
}

export async function findAccountById(id: string) {
  const accounts = await readAccounts()
  return accounts.find((account) => account.id === id) ?? null
}

export async function findAccountByUsername(username: string) {
  const target = normalizeUsername(username)
  if (!target) return null
  const accounts = await readAccounts()
  return accounts.find((account) => account.username === target) ?? null
}

export interface CreateAccountInput {
  id?: string
  username: string
  role?: AccountRole
  status?: AccountStatus
  passwordSalt: string
  passwordHash: string
}

export async function createAccount(input: CreateAccountInput) {
  return enqueueAccountsMutation(async () => {
    const accounts = await readAccounts()
    const username = validateUsername(input.username)
    if (accounts.some((account) => account.username === username)) {
      throw new Error("该用户名已被占用")
    }
    const now = new Date().toISOString()
    const account: AccountRecord = {
      id: input.id ?? randomUUID(),
      username,
      role: input.role ?? "member",
      status: input.status ?? "pending",
      passwordSalt: input.passwordSalt,
      passwordHash: input.passwordHash,
      createdAt: now,
      updatedAt: now,
      ...(input.status === "active" ? { approvedAt: now } : {}),
    }
    await writeAccounts([...accounts, account])
    return account
  })
}

export interface UpdateAccountPatch {
  status?: AccountStatus
  role?: AccountRole
  passwordSalt?: string
  passwordHash?: string
  approvedBy?: string
}

export async function updateAccount(id: string, patch: UpdateAccountPatch) {
  return enqueueAccountsMutation(async () => {
    const accounts = await readAccounts()
    const index = accounts.findIndex((account) => account.id === id)
    if (index < 0) throw new Error("账号不存在")
    const current = accounts[index]
    const now = new Date().toISOString()
    const next: AccountRecord = {
      ...current,
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.role ? { role: patch.role } : {}),
      ...(patch.passwordSalt ? { passwordSalt: patch.passwordSalt } : {}),
      ...(patch.passwordHash ? { passwordHash: patch.passwordHash } : {}),
      ...(patch.status === "active" && !current.approvedAt
        ? { approvedAt: now, ...(patch.approvedBy ? { approvedBy: patch.approvedBy } : {}) }
        : {}),
      updatedAt: now,
    }
    const nextAccounts = [...accounts]
    nextAccounts[index] = next
    await writeAccounts(nextAccounts)
    return next
  })
}

export async function listAccounts() {
  const accounts = await readAccounts()
  return [...accounts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** 只用于测试：清空进程内缓存。 */
export function resetAccountsCacheForTests() {
  accountsCache = null
}
