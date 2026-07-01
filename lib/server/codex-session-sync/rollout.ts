import "server-only"

import { createReadStream, createWriteStream } from "node:fs"
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { backupRoot, codexHome, SESSION_DIR_NAMES } from "./paths"

interface RolloutMeta {
  path: string
  directory: "sessions" | "archived_sessions"
  firstLine: string
  separator: string
  offset: number
  size: number
  mtimeMs: number
  record: {
    type: "session_meta"
    payload: Record<string, unknown>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function parseSessionMeta(firstLine: string) {
  try {
    const parsed = JSON.parse(firstLine) as unknown
    if (!isRecord(parsed) || parsed.type !== "session_meta" || !isRecord(parsed.payload)) {
      return null
    }
    return parsed as RolloutMeta["record"]
  } catch {
    return null
  }
}

async function listRolloutFiles(rootDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(/* turbopackIgnore: true */ rootDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const files: string[] = []
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name)
    if (entry.isDirectory()) files.push(...(await listRolloutFiles(fullPath)))
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(fullPath)
    }
  }
  return files
}

async function readFirstLine(filePath: string) {
  const handle = await open(/* turbopackIgnore: true */ filePath, "r")
  try {
    let position = 0
    let collected = Buffer.alloc(0)
    while (true) {
      const chunk = Buffer.alloc(64 * 1024)
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      position += bytesRead
      collected = Buffer.concat([collected, chunk.subarray(0, bytesRead)])
      const newlineIndex = collected.indexOf(0x0a)
      if (newlineIndex >= 0) {
        const crlf = newlineIndex > 0 && collected[newlineIndex - 1] === 0x0d
        const lineBuffer = crlf
          ? collected.subarray(0, newlineIndex - 1)
          : collected.subarray(0, newlineIndex)
        return {
          firstLine: lineBuffer.toString("utf8"),
          separator: crlf ? "\r\n" : "\n",
          offset: newlineIndex + 1,
        }
      }
    }
    return {
      firstLine: collected.toString("utf8"),
      separator: "",
      offset: collected.length,
    }
  } finally {
    await handle.close()
  }
}

async function restoreMtime(filePath: string, mtimeMs: number) {
  if (!Number.isFinite(mtimeMs)) return
  try {
    const current = await stat(/* turbopackIgnore: true */ filePath)
    await utimes(/* turbopackIgnore: true */ filePath, current.atime, new Date(mtimeMs))
  } catch {
    // mtime preservation is best effort; metadata content is the important part.
  }
}

async function rewriteFirstLine(meta: RolloutMeta, nextFirstLine: string) {
  const current = await readFirstLine(meta.path)
  const currentStat = await stat(/* turbopackIgnore: true */ meta.path)
  if (
    current.firstLine !== meta.firstLine ||
    current.offset !== meta.offset ||
    currentStat.size !== meta.size ||
    currentStat.mtimeMs !== meta.mtimeMs
  ) {
    throw new Error(`会话文件已变化，已跳过避免覆盖：${meta.path}`)
  }

  const tmpPath = `${meta.path}.switchgate-session-sync.${process.pid}.${Date.now()}.tmp`
  const writer = createWriteStream(/* turbopackIgnore: true */ tmpPath, { encoding: "utf8" })
  try {
    await new Promise<void>((resolve, reject) => {
      writer.on("error", reject)
      writer.write(nextFirstLine)
      if (meta.separator) writer.write(meta.separator)
      const headerOnly = meta.offset >= meta.size
      if (headerOnly) {
        writer.end()
        writer.once("finish", resolve)
        return
      }
      const reader = createReadStream(/* turbopackIgnore: true */ meta.path, { start: meta.offset })
      reader.on("error", reject)
      reader.on("end", () => writer.end())
      writer.once("finish", resolve)
      reader.pipe(writer, { end: false })
    })
    await rename(/* turbopackIgnore: true */ tmpPath, /* turbopackIgnore: true */ meta.path)
    await restoreMtime(meta.path, meta.mtimeMs)
  } catch (error) {
    await rm(/* turbopackIgnore: true */ tmpPath, { force: true })
    throw error
  }
}

export async function listRolloutMetas(home = codexHome()) {
  const metas: RolloutMeta[] = []
  for (const directory of SESSION_DIR_NAMES) {
    const root = join(home, directory)
    const files = await listRolloutFiles(root)
    for (const filePath of files) {
      const firstLine = await readFirstLine(filePath)
      const record = parseSessionMeta(firstLine.firstLine)
      if (!record) continue
      const fileStat = await stat(/* turbopackIgnore: true */ filePath)
      metas.push({
        path: filePath,
        directory,
        firstLine: firstLine.firstLine,
        separator: firstLine.separator,
        offset: firstLine.offset,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        record,
      })
    }
  }
  return metas
}

export async function syncRolloutProviders(home: string, provider: string) {
  const metas = await listRolloutMetas(home)
  let changedSessionFiles = 0
  const skippedLockedRolloutFiles: string[] = []
  for (const meta of metas) {
    if (meta.record.payload.model_provider === provider) continue
    const nextRecord = {
      ...meta.record,
      payload: {
        ...meta.record.payload,
        model_provider: provider,
      },
    }
    try {
      await rewriteFirstLine(meta, JSON.stringify(nextRecord))
      changedSessionFiles += 1
    } catch {
      skippedLockedRolloutFiles.push(meta.path)
    }
  }
  return { changedSessionFiles, skippedLockedRolloutFiles }
}

export async function moveRolloutFilesToBackupByIds(
  home: string,
  threadIds: string[],
  backupDir: string,
) {
  const ids = new Set(threadIds.map((id) => id.trim()).filter(Boolean))
  if (ids.size === 0) return 0
  const metas = await listRolloutMetas(home)
  const targets = metas.filter((meta) => ids.has(String(meta.record.payload.id || "")))
  let moved = 0
  for (const meta of targets) {
    const rel = relative(home, meta.path)
    const target = join(backupDir, "deleted-rollouts", rel || basename(meta.path))
    await mkdir(/* turbopackIgnore: true */ dirname(target), { recursive: true })
    await rename(/* turbopackIgnore: true */ meta.path, /* turbopackIgnore: true */ target)
    moved += 1
  }
  return moved
}

export async function createRolloutDeleteBackupForIds(home: string, threadIds: string[]) {
  const ids = Array.from(new Set(threadIds.map((id) => id.trim()).filter(Boolean)))
  const suffix = ids.length === 1 ? ids[0] : `${ids.length}-sessions`
  const backupDir = join(
    backupRoot(home),
    `${new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replace(".", "")}-delete-${suffix}`,
  )
  await mkdir(/* turbopackIgnore: true */ backupDir, { recursive: true })
  await writeFile(
    /* turbopackIgnore: true */ join(backupDir, "metadata.json"),
    `${JSON.stringify(
      {
        version: 1,
        namespace: "provider-sync",
        operation: "delete-sessions",
        codexHome: home,
        threadIds: ids,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  try {
    const globalState = await readFile(/* turbopackIgnore: true */ join(home, ".codex-global-state.json"), "utf8")
    await writeFile(/* turbopackIgnore: true */ join(backupDir, ".codex-global-state.json"), globalState, "utf8")
  } catch {
    // Global state is optional.
  }
  await backupSessionIndexFiles(home, backupDir)
  return backupDir
}

async function backupSessionIndexFiles(home: string, backupDir: string) {
  for (const relativePath of ["session_index.jsonl", "sqlite/session_index.jsonl"]) {
    try {
      const content = await readFile(/* turbopackIgnore: true */ join(home, relativePath), "utf8")
      const target = join(backupDir, "session-index", relativePath)
      await mkdir(/* turbopackIgnore: true */ dirname(target), { recursive: true })
      await writeFile(/* turbopackIgnore: true */ target, content, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
}
