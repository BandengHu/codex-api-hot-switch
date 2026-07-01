import "server-only"

import { readdir, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type {
  CodexSessionClearBackupsResult,
  CodexSessionDeleteResult,
  CodexSessionSyncResult,
  CodexSessionSyncStatus,
} from "@/lib/codex-session-types"
import { readCodexProviderInfo } from "./config"
import {
  collectLatestThreads,
  createDatabaseBackup,
  deleteThreadsFromDatabases,
  listDatabaseStatuses,
  mergeLatestThreadsIntoCanonical,
} from "./database"
import { backupRoot, codexHome, detectCanonicalStateDb, fileExists } from "./paths"
import {
  createRolloutDeleteBackupForIds,
  moveRolloutFilesToBackupByIds,
  syncRolloutProviders,
} from "./rollout"
import { syncWorkspaceRoots } from "./workspace-roots"

type VendorStatus = {
  rolloutCounts?: CodexSessionSyncStatus["rolloutCounts"]
  sqliteCounts?: CodexSessionSyncStatus["sqliteCounts"] & { unreadable?: boolean }
  encryptedContentWarning?: string | null
  lockedRolloutFiles?: string[]
  backupSummary?: { count?: number; totalBytes?: number }
}

async function getVendorStatus(home: string): Promise<VendorStatus> {
  try {
    const service = (await import(
      "@/lib/server/vendor/codex-provider-sync/service.js"
    )) as unknown as {
      getStatus?: (options: { codexHome: string }) => Promise<VendorStatus>
    }
    return service.getStatus ? await service.getStatus({ codexHome: home }) : {}
  } catch {
    return {}
  }
}

async function backupSummary(home: string) {
  const root = backupRoot(home)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { count: 0, totalBytes: 0 }
    }
    throw error
  }
  let count = 0
  let totalBytes = 0
  async function sizeOf(path: string): Promise<number> {
    const fileStat = await stat(path)
    if (fileStat.isFile()) return fileStat.size
    if (!fileStat.isDirectory()) return 0
    const children = await readdir(path, { withFileTypes: true })
    let total = 0
    for (const child of children) total += await sizeOf(join(path, child.name))
    return total
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    count += 1
    totalBytes += await sizeOf(join(root, entry.name))
  }
  return { count, totalBytes }
}

async function removeBackupChildren(home: string) {
  const root = resolve(backupRoot(home))
  const expectedRoot = resolve(home, "backups_state", "provider-sync")
  if (root !== expectedRoot) {
    throw new Error(`备份目录解析异常，已拒绝清空：${root}`)
  }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { deletedCount: 0, freedBytes: 0 }
    }
    throw error
  }

  async function sizeOf(path: string): Promise<number> {
    const fileStat = await stat(path)
    if (fileStat.isFile()) return fileStat.size
    if (!fileStat.isDirectory()) return 0
    const children = await readdir(path, { withFileTypes: true })
    let total = 0
    for (const child of children) total += await sizeOf(join(path, child.name))
    return total
  }

  let deletedCount = 0
  let freedBytes = 0
  for (const entry of entries) {
    const target = resolve(root, entry.name)
    if (target === root || !target.startsWith(`${root}\\`)) {
      throw new Error(`备份子项路径异常，已拒绝删除：${target}`)
    }
    freedBytes += await sizeOf(target)
    await rm(target, { recursive: true, force: true })
    deletedCount += 1
  }
  return { deletedCount, freedBytes }
}

export async function getCodexSessionSyncStatus(): Promise<CodexSessionSyncStatus> {
  const home = codexHome()
  const providerInfo = await readCodexProviderInfo(home)
  const databases = await listDatabaseStatuses(home)
  const canonical = await detectCanonicalStateDb(home)
  const { sessions } = await collectLatestThreads(home)
  const vendor = await getVendorStatus(home)
  const backups = vendor.backupSummary || (await backupSummary(home))
  const sqliteCounts =
    vendor.sqliteCounts && !vendor.sqliteCounts.unreadable
      ? {
          sessions: vendor.sqliteCounts.sessions || {},
          archived_sessions: vendor.sqliteCounts.archived_sessions || {},
        }
      : null

  return {
    codexHome: home,
    currentProvider: providerInfo.currentProvider,
    configuredProviders: providerInfo.configuredProviders,
    databases,
    canonicalDbPath: canonical?.path || "",
    backupRoot: backupRoot(home),
    backupCount: Number(backups.count) || 0,
    backupBytes: Number(backups.totalBytes) || 0,
    rolloutCounts: vendor.rolloutCounts || { sessions: {}, archived_sessions: {} },
    sqliteCounts,
    encryptedContentWarning: vendor.encryptedContentWarning || null,
    lockedRolloutFiles: vendor.lockedRolloutFiles || [],
    totalSessions: sessions.length,
    sessions,
  }
}

export async function syncCodexSessions(): Promise<CodexSessionSyncResult> {
  const home = codexHome()
  const { currentProvider } = await readCodexProviderInfo(home)
  const backup = await createDatabaseBackup(home, "sync-sessions")
  const mergeResult = await mergeLatestThreadsIntoCanonical(home, currentProvider)
  const rolloutResult = await syncRolloutProviders(home, currentProvider)
  const workspaceResult = await syncWorkspaceRoots(home)
  const status = await getCodexSessionSyncStatus()
  return {
    status,
    message: `已同步 ${status.totalSessions} 个会话到当前 Codex 会话库`,
    targetProvider: currentProvider,
    previousProvider: currentProvider,
    backupDir: backup.backupDir,
    changedSessionFiles: rolloutResult.changedSessionFiles,
    sqliteRowsUpdated:
      mergeResult.mergedThreads +
      mergeResult.deletedDuplicateThreads +
      status.totalSessions,
    sqliteProviderRowsUpdated: status.totalSessions,
    sqliteUserEventRowsUpdated: 0,
    sqliteCwdRowsUpdated: 0,
    mergedThreads: mergeResult.mergedThreads,
    deletedDuplicateThreads: mergeResult.deletedDuplicateThreads,
    updatedWorkspaceRoots: workspaceResult.updatedWorkspaceRoots,
    skippedLockedRolloutFiles: rolloutResult.skippedLockedRolloutFiles,
  }
}

export async function deleteCodexSessions(threadIds: string[]): Promise<CodexSessionDeleteResult> {
  const ids = Array.from(new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean)))
  if (ids.length === 0) throw new Error("缺少会话 ID")
  const home = codexHome()
  const backup = await createDatabaseBackup(home, "delete-sessions")
  const deleteBackupDir = await createRolloutDeleteBackupForIds(home, ids)
  await writeFile(
    join(deleteBackupDir, "database-backup.json"),
    `${JSON.stringify({ databaseBackupDir: backup.backupDir }, null, 2)}\n`,
    "utf8",
  )
  const deletedRolloutFiles = await moveRolloutFilesToBackupByIds(home, ids, deleteBackupDir)
  const { deletedSqliteRows, deletedSessionIndexRows } = await deleteThreadsFromDatabases(
    home,
    ids,
  )

  const status = await getCodexSessionSyncStatus()
  const message =
    deletedSqliteRows === 0 && deletedRolloutFiles === 0 && deletedSessionIndexRows === 0
      ? "没有找到选中的会话，未删除任何记录"
      : `已删除 ${ids.length} 个会话`
  return {
    status,
    message,
    deletedThreadIds: ids,
    deletedSqliteRows,
    deletedRolloutFiles,
    deletedSessionIndexRows,
    backupDir: deleteBackupDir || backup.backupDir,
  }
}

export async function clearCodexSessionBackups(): Promise<CodexSessionClearBackupsResult> {
  const home = codexHome()
  const root = backupRoot(home)
  const result = await removeBackupChildren(home)
  const status = await getCodexSessionSyncStatus()
  return {
    status,
    message:
      result.deletedCount > 0
        ? `已清空 ${result.deletedCount} 个会话备份`
        : "备份目录已经是空的",
    backupRoot: root,
    deletedCount: result.deletedCount,
    freedBytes: result.freedBytes,
  }
}

export async function canAccessCodexHome() {
  return fileExists(codexHome())
}
