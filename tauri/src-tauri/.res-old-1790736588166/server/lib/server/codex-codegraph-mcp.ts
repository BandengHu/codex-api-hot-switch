import "server-only"

import { spawn } from "node:child_process"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { dirname, join } from "node:path"
import { env as processEnv } from "node:process"
import { discoverCodegraphProjects } from "./codegraph-project-discovery"
import {
  CODEGRAPH_MCP_SERVER_NAME,
  CODEGRAPH_PACKAGE_NAME,
  agentsInstructionsInstalled,
  codegraphMcpConfigInstalled,
  installCodegraphMcpConfigText,
  readSectionString,
  readSectionStringArray,
  removeCodegraphAgentsInstructions,
  removeCodegraphMcpConfigText,
  sectionBoolean,
  upsertCodegraphAgentsInstructions,
} from "@/lib/codex-codegraph-text"

export {
  CODEGRAPH_INSTRUCTIONS_BLOCK,
  CODEGRAPH_MCP_SERVER_NAME,
  CODEGRAPH_PACKAGE_NAME,
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
  agentsInstructionsInstalled,
  codegraphMcpBlock,
  codegraphMcpConfigInstalled,
  installCodegraphMcpConfigText,
  removeCodegraphAgentsInstructions,
  removeCodegraphMcpConfigText,
  upsertCodegraphAgentsInstructions,
} from "@/lib/codex-codegraph-text"

export type CodegraphMcpStatus = {
  serverName: string
  installed: boolean
  enabled: boolean
  command: string
  args: string[]
  cliAvailable: boolean
  cliCommand: string
  cliVersion: string
  agentsInstructionsInstalled: boolean
  agentsPath: string
  ready: boolean
}

async function pathExists(path: string) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function runCommand(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; cwd?: string },
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: true,
      windowsHide: true,
      env: processEnv,
      cwd: options?.cwd || undefined,
    })
    let stdout = ""
    let stderr = ""
    const timer =
      options?.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill()
            reject(new Error(`命令超时：${command} ${args.join(" ")}`))
          }, options.timeoutMs)
        : null
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function candidateCliPaths() {
  const paths: string[] = []
  if (processEnv.CODEGRAPH_PATH?.trim()) paths.push(processEnv.CODEGRAPH_PATH.trim())
  if (processEnv.SWITCHGATE_CODEGRAPH_PATH?.trim()) {
    paths.push(processEnv.SWITCHGATE_CODEGRAPH_PATH.trim())
  }

  const appData = processEnv.APPDATA || ""
  if (appData) {
    paths.push(join(appData, "npm", "codegraph.cmd"))
    paths.push(join(appData, "npm", "codegraph"))
  }

  try {
    const { code, stdout } = await runCommand("where.exe", ["codegraph"], { timeoutMs: 8_000 })
    if (code === 0) {
      for (const line of stdout.split(/\r?\n/)) {
        const item = line.trim()
        if (item) paths.push(item)
      }
    }
  } catch {
    // ignore
  }

  paths.push("codegraph")
  return [...new Set(paths)]
}

export async function resolveCodegraphCli() {
  for (const candidate of await candidateCliPaths()) {
    if (candidate === "codegraph") {
      try {
        const result = await runCommand(candidate, ["--version"], { timeoutMs: 12_000 })
        if (result.code === 0) {
          return {
            available: true,
            command: candidate,
            version: result.stdout.trim() || result.stderr.trim(),
          }
        }
      } catch {
        continue
      }
      continue
    }
    if (!(await pathExists(candidate))) continue
    try {
      const result = await runCommand(candidate, ["--version"], { timeoutMs: 12_000 })
      if (result.code === 0) {
        return {
          available: true,
          command: candidate,
          version: result.stdout.trim() || result.stderr.trim(),
        }
      }
    } catch {
      // keep looking
    }
  }
  return {
    available: false,
    command: "codegraph",
    version: "",
  }
}

export async function ensureCodegraphCliInstalled() {
  const existing = await resolveCodegraphCli()
  if (existing.available) return existing

  const install = await runCommand(
    "npm",
    ["install", "-g", CODEGRAPH_PACKAGE_NAME],
    { timeoutMs: 180_000 },
  )
  if (install.code !== 0) {
    throw new Error(
      `安装 ${CODEGRAPH_PACKAGE_NAME} 失败：${(install.stderr || install.stdout || "unknown error").trim()}`,
    )
  }

  const resolved = await resolveCodegraphCli()
  if (!resolved.available) {
    throw new Error(
      `${CODEGRAPH_PACKAGE_NAME} 已执行全局安装，但本机仍找不到 codegraph 可执行文件。请打开新终端后重试，或设置 CODEGRAPH_PATH。`,
    )
  }
  return resolved
}

async function runCodegraphInit(command: string, root: string) {
  const result = await runCommand(command, ["init"], {
    cwd: root,
    timeoutMs: 600_000,
  })
  if (result.code !== 0) {
    throw new Error(
      `codegraph init 失败（${root}）：${(result.stderr || result.stdout || "unknown error").trim()}`,
    )
  }
  return {
    projectPath: root,
    output: (result.stdout || result.stderr || "").trim(),
  }
}

export async function initCodegraphProjects(selectedPath: string) {
  const discovery = await discoverCodegraphProjects(selectedPath)
  const totalProjects =
    discovery.projectRoots.length + discovery.indexedProjectRoots.length
  if (totalProjects === 0) {
    throw new Error(
      `在 ${discovery.selectedPath} 及其子目录中未发现带 .git 标记的项目`,
    )
  }
  if (discovery.projectRoots.length === 0) {
    return {
      ...discovery,
      initializedProjects: [] as Array<{ projectPath: string; output: string }>,
    }
  }

  const cli = await ensureCodegraphCliInstalled()
  const initializedProjects: Array<{ projectPath: string; output: string }> = []
  const failures: string[] = []
  for (const projectPath of discovery.projectRoots) {
    try {
      initializedProjects.push(await runCodegraphInit(cli.command, projectPath))
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        `CodeGraph 批量建索引未全部完成：成功 ${initializedProjects.length} 个，失败 ${failures.length} 个`,
        ...failures,
      ].join("\n"),
    )
  }

  return {
    ...discovery,
    initializedProjects,
  }
}

export function agentsInstructionsPath(codexHome: string) {
  return join(codexHome, "AGENTS.md")
}

async function detectCodegraphCliQuick() {
  const paths: string[] = []
  if (processEnv.CODEGRAPH_PATH?.trim()) paths.push(processEnv.CODEGRAPH_PATH.trim())
  if (processEnv.SWITCHGATE_CODEGRAPH_PATH?.trim()) {
    paths.push(processEnv.SWITCHGATE_CODEGRAPH_PATH.trim())
  }
  const appData = processEnv.APPDATA || ""
  if (appData) {
    paths.push(join(appData, "npm", "codegraph.cmd"))
    paths.push(join(appData, "npm", "codegraph"))
  }
  for (const candidate of [...new Set(paths)]) {
    if (await pathExists(candidate)) {
      return { available: true, command: candidate }
    }
  }
  return { available: false, command: "codegraph" }
}

export async function getCodegraphMcpStatus(params: {
  codexHome: string
  configText: string
}): Promise<CodegraphMcpStatus> {
  const section = `mcp_servers.${CODEGRAPH_MCP_SERVER_NAME}`
  const command = readSectionString(params.configText, section, "command")
  const args = readSectionStringArray(params.configText, section, "args")
  const enabled = sectionBoolean(params.configText, section, "enabled")
  const agentsPath = agentsInstructionsPath(params.codexHome)
  const agentsText = (await pathExists(agentsPath)) ? await readFile(agentsPath, "utf8") : ""
  const cli = await detectCodegraphCliQuick()
  const configuredCommand = command || cli.command
  const configuredExists =
    Boolean(command) && command !== "codegraph" ? await pathExists(command) : cli.available
  const installed = codegraphMcpConfigInstalled(params.configText)
  const agentsOk = agentsInstructionsInstalled(agentsText)
  const cliAvailable = configuredExists || cli.available
  let cliVersion = ""
  if (cliAvailable) {
    try {
      const versioned = await resolveCodegraphCli()
      if (versioned.available) cliVersion = versioned.version
    } catch {
      cliVersion = ""
    }
  }
  return {
    serverName: CODEGRAPH_MCP_SERVER_NAME,
    installed,
    enabled: enabled !== false,
    command,
    args,
    cliAvailable,
    cliCommand: configuredCommand,
    cliVersion,
    agentsInstructionsInstalled: agentsOk,
    agentsPath,
    ready: installed && cliAvailable && agentsOk && enabled !== false,
  }
}

export async function writeCodegraphAgentsInstructions(codexHome: string) {
  const path = agentsInstructionsPath(codexHome)
  await mkdir(dirname(path), { recursive: true })
  const current = (await pathExists(path)) ? await readFile(path, "utf8") : ""
  await writeFile(path, upsertCodegraphAgentsInstructions(current), "utf8")
  return path
}

export async function clearCodegraphAgentsInstructions(codexHome: string) {
  const path = agentsInstructionsPath(codexHome)
  if (!(await pathExists(path))) return path
  const current = await readFile(path, "utf8")
  const next = removeCodegraphAgentsInstructions(current)
  await writeFile(path, next, "utf8")
  return path
}
