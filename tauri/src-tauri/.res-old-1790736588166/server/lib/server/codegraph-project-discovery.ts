import { readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"

const MAX_SCANNED_DIRECTORIES = 20_000

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".cache",
  ".codegraph",
  ".git",
  ".idea",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".venv",
  ".vscode",
  "__pycache__",
  "_reference",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
])

export type CodegraphProjectDiscovery = {
  selectedPath: string
  scannedDirectories: number
  projectRoots: string[]
  indexedProjectRoots: string[]
}

function excludedDirectory(name: string) {
  const normalized = name.toLowerCase()
  return EXCLUDED_DIRECTORY_NAMES.has(normalized) || normalized.startsWith("dist-")
}

export async function discoverCodegraphProjects(
  selectedPath: string,
): Promise<CodegraphProjectDiscovery> {
  const root = resolve(selectedPath.trim())
  if (!selectedPath.trim()) throw new Error("项目路径不能为空")

  let rootInfo
  try {
    rootInfo = await stat(root)
  } catch {
    throw new Error(`项目路径不存在：${root}`)
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`项目路径不是目录：${root}`)
  }

  const pending = [root]
  const projectRoots: string[] = []
  const indexedProjectRoots: string[] = []
  let scannedDirectories = 0

  while (pending.length > 0) {
    const current = pending.pop()!
    scannedDirectories += 1
    if (scannedDirectories > MAX_SCANNED_DIRECTORIES) {
      throw new Error(
        `CodeGraph 项目扫描超过 ${MAX_SCANNED_DIRECTORIES} 个目录，请选择范围更小的工作区`,
      )
    }

    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      throw new Error(
        `无法读取目录 ${current}：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const entryNames = new Set(entries.map((entry) => entry.name.toLowerCase()))
    if (entryNames.has(".git")) {
      if (entryNames.has(".codegraph")) {
        indexedProjectRoots.push(current)
      } else {
        projectRoots.push(current)
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || excludedDirectory(entry.name)) {
        continue
      }
      pending.push(resolve(current, entry.name))
    }
  }

  projectRoots.sort((left, right) => left.localeCompare(right))
  indexedProjectRoots.sort((left, right) => left.localeCompare(right))
  return {
    selectedPath: root,
    scannedDirectories,
    projectRoots,
    indexedProjectRoots,
  }
}
