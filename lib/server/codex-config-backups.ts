import "server-only"

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { CodexConfigBackup } from "@/lib/codex-config-types"

const BACKUP_ROOT_NAME = "codex-switchgate-config-backups"
const CONFIG_FILE_NAME = "config.toml"
const AUTH_FILE_NAME = "auth.json"
const METADATA_FILE_NAME = "metadata.json"

interface BackupMetadata {
  id: string
  createdAt: string
  note: string
  sourceConfigPath: string
  sourceAuthPath: string
}

export function codexConfigBackupRoot(codexHome: string) {
  return join(codexHome, BACKUP_ROOT_NAME)
}

function backupDir(codexHome: string, backupId: string) {
  assertBackupId(backupId)
  return join(codexConfigBackupRoot(codexHome), backupId)
}

function backupConfigPath(codexHome: string, backupId: string) {
  return join(backupDir(codexHome, backupId), CONFIG_FILE_NAME)
}

function backupAuthPath(codexHome: string, backupId: string) {
  return join(backupDir(codexHome, backupId), AUTH_FILE_NAME)
}

function backupMetadataPath(codexHome: string, backupId: string) {
  return join(backupDir(codexHome, backupId), METADATA_FILE_NAME)
}

function assertBackupId(backupId: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(backupId)) {
    throw new Error("备份 ID 非法")
  }
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function normalizeNote(note?: string) {
  return (note ?? "").trim().slice(0, 200)
}

function createBackupId(date: Date) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${suffix}`
}

async function readBackupMetadata(codexHome: string, backupId: string): Promise<BackupMetadata> {
  const metadataPath = backupMetadataPath(codexHome, backupId)
  const raw = await readFile(metadataPath, "utf8")
  const parsed = JSON.parse(raw) as Partial<BackupMetadata>
  return {
    id: parsed.id || backupId,
    createdAt: parsed.createdAt || new Date().toISOString(),
    note: normalizeNote(parsed.note),
    sourceConfigPath: parsed.sourceConfigPath || "",
    sourceAuthPath: parsed.sourceAuthPath || "",
  }
}

async function writeBackupMetadata(codexHome: string, metadata: BackupMetadata) {
  const metadataPath = backupMetadataPath(codexHome, metadata.id)
  await mkdir(dirname(metadataPath), { recursive: true })
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
}

async function toBackup(codexHome: string, metadata: BackupMetadata): Promise<CodexConfigBackup> {
  const authPath = backupAuthPath(codexHome, metadata.id)
  return {
    id: metadata.id,
    createdAt: metadata.createdAt,
    note: metadata.note,
    path: backupDir(codexHome, metadata.id),
    configPath: backupConfigPath(codexHome, metadata.id),
    authPath,
    hasAuth: await exists(authPath),
  }
}

export async function listCodexConfigBackups(codexHome: string): Promise<CodexConfigBackup[]> {
  const root = codexConfigBackupRoot(codexHome)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const backups: CodexConfigBackup[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const backupId = entry.name
    if (!/^[A-Za-z0-9_.-]+$/.test(backupId)) continue
    if (!(await exists(backupConfigPath(codexHome, backupId)))) continue
    try {
      backups.push(await toBackup(codexHome, await readBackupMetadata(codexHome, backupId)))
    } catch {
      const stats = await stat(backupConfigPath(codexHome, backupId))
      backups.push(
        await toBackup(codexHome, {
          id: backupId,
          createdAt: stats.mtime.toISOString(),
          note: "",
          sourceConfigPath: "",
          sourceAuthPath: "",
        }),
      )
    }
  }

  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function createCodexConfigBackup(params: {
  codexHome: string
  configPath: string
  authPath: string
  note?: string
}): Promise<CodexConfigBackup> {
  if (!(await exists(params.configPath))) {
    throw new Error("没有找到可备份的 Codex 配置文件")
  }
  const createdAt = new Date().toISOString()
  const metadata: BackupMetadata = {
    id: createBackupId(new Date(createdAt)),
    createdAt,
    note: normalizeNote(params.note),
    sourceConfigPath: params.configPath,
    sourceAuthPath: params.authPath,
  }
  await mkdir(backupDir(params.codexHome, metadata.id), { recursive: true })
  await copyFile(params.configPath, backupConfigPath(params.codexHome, metadata.id))
  if (await exists(params.authPath)) {
    await copyFile(params.authPath, backupAuthPath(params.codexHome, metadata.id))
  }
  await writeBackupMetadata(params.codexHome, metadata)
  return await toBackup(params.codexHome, metadata)
}

export async function restoreCodexConfigBackup(params: {
  codexHome: string
  configPath: string
  authPath: string
  backupId: string
}) {
  const sourceConfig = backupConfigPath(params.codexHome, params.backupId)
  if (!(await exists(sourceConfig))) {
    throw new Error("指定备份不存在")
  }
  await mkdir(dirname(params.configPath), { recursive: true })
  await copyFile(sourceConfig, params.configPath)
  const sourceAuth = backupAuthPath(params.codexHome, params.backupId)
  if (await exists(sourceAuth)) {
    await mkdir(dirname(params.authPath), { recursive: true })
    await copyFile(sourceAuth, params.authPath)
  } else {
    await rm(params.authPath, { force: true })
  }
}

export async function deleteCodexConfigBackups(params: {
  codexHome: string
  backupIds: string[]
}) {
  let deleted = 0
  for (const backupId of params.backupIds) {
    assertBackupId(backupId)
    const dir = backupDir(params.codexHome, backupId)
    if (!(await exists(dir))) continue
    await rm(dir, { recursive: true, force: true })
    deleted += 1
  }
  return deleted
}

export async function updateCodexConfigBackupNote(params: {
  codexHome: string
  backupId: string
  note: string
}): Promise<CodexConfigBackup> {
  const metadata = await readBackupMetadata(params.codexHome, params.backupId)
  const next = { ...metadata, note: normalizeNote(params.note) }
  await writeBackupMetadata(params.codexHome, next)
  return await toBackup(params.codexHome, next)
}
