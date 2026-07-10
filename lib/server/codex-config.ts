import "server-only"

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { delimiter } from "node:path"
import { dirname, join, resolve } from "node:path"
import type {
  CodexConfigMutationResult,
  CodexConfigStatus,
} from "@/lib/codex-config-types"
import { buildCodexClientModelsResponse, CODEX_AUTO_MODEL_SLUG } from "@/lib/server/codex-model-catalog"
import { getSnapshot } from "@/lib/server/state-store"
import {
  codexConfigBackupRoot,
  createCodexConfigBackup,
  deleteCodexConfigBackups,
  listCodexConfigBackups,
  restoreCodexConfigBackup,
  updateCodexConfigBackupNote,
} from "./codex-config-backups"
import type { ConsoleSnapshot, Settings } from "@/lib/types"

const NEW_CONFIG_PROVIDER_ID = "codex_local_access"
const DEFAULT_PROVIDER_NAME = "Codex API Service"
const DEFAULT_MODEL = CODEX_AUTO_MODEL_SLUG
const DEFAULT_REASONING = "high"
const MODEL_CATALOG_NAME = "codex-switchgate-model-catalog.json"
const WEB_SEARCH_MCP_SERVER_NAME = "switchgate_web_search"
const WEB_SEARCH_MCP_SCRIPT_NAME = "switchgate-web-search-mcp.cjs"

function codexHome() {
  return process.env.CODEX_HOME || join(process.env.USERPROFILE || process.cwd(), ".codex")
}

function configPath() {
  return join(codexHome(), "config.toml")
}

function authPath() {
  return join(codexHome(), "auth.json")
}

function backupPath() {
  return codexConfigBackupRoot(codexHome())
}

function modelCatalogPath() {
  return join(codexHome(), MODEL_CATALOG_NAME)
}

function webSearchMcpScriptPath() {
  return resolve(process.cwd(), "scripts", WEB_SEARCH_MCP_SCRIPT_NAME)
}

function tomlString(value: string) {
  return JSON.stringify(value)
}

function targetBaseUrl(settings: Settings) {
  const host = settings.listenAddress === "0.0.0.0" ? "127.0.0.1" : settings.listenAddress
  return `http://${host}:${settings.port}/v1`
}

function normalizePathname(pathname: string) {
  const normalized = pathname.replace(/\/+$/, "")
  return normalized || "/"
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1")
}

function isLoopbackHost(hostname: string) {
  const host = normalizeHostname(hostname)
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1"
}

function urlPort(url: URL) {
  if (url.port) return url.port
  return url.protocol === "https:" ? "443" : "80"
}

function sameLocalBaseUrl(currentBaseUrl: string, expectedBaseUrl: string) {
  if (!currentBaseUrl.trim()) return false
  try {
    const current = new URL(currentBaseUrl)
    const expected = new URL(expectedBaseUrl)
    const sameProtocol = current.protocol === expected.protocol
    const samePort = urlPort(current) === urlPort(expected)
    const samePath = normalizePathname(current.pathname) === normalizePathname(expected.pathname)
    const sameHost =
      normalizeHostname(current.hostname) === normalizeHostname(expected.hostname) ||
      (isLoopbackHost(current.hostname) && isLoopbackHost(expected.hostname))
    return sameProtocol && samePort && samePath && sameHost
  } catch {
    return currentBaseUrl.trim().replace(/\/+$/, "") === expectedBaseUrl.trim().replace(/\/+$/, "")
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

async function readTextIfExists(path: string) {
  return (await exists(path)) ? await readFile(path, "utf8") : ""
}

function parseTomlQuotedString(raw: string) {
  const value = raw.trim()
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'")) return value.slice(1, -1)
  return value
}

function topLevelString(text: string, key: string) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*((?:\"(?:\\\\.|[^\"])*\")|(?:'[^']*'))\\s*$`, "m"))
  return match ? parseTomlQuotedString(match[1]) : ""
}

function sectionBody(text: string, section: string) {
  const lines = text.split(/\r?\n/)
  const header = `[${section}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start < 0) return ""
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start + 1, end).join("\n")
}

function sectionString(text: string, section: string, key: string) {
  return topLevelString(sectionBody(text, section), key)
}

function upsertTopLevelString(text: string, key: string, value: string) {
  const line = `${key} = ${tomlString(value)}`
  const pattern = new RegExp(`^${key}\\s*=.*$`, "m")
  if (pattern.test(text)) return text.replace(pattern, line)
  return `${line}\n${text}`
}

function upsertTopLevelStringIfMissing(text: string, key: string, value: string) {
  const pattern = new RegExp(`^${key}\\s*=.*$`, "m")
  return pattern.test(text) ? text : upsertTopLevelString(text, key, value)
}

function removeTopLevelKey(text: string, key: string) {
  const lines = text.split(/\r?\n/)
  let inTopLevel = true
  return lines
    .filter((line) => {
      if (/^\s*\[/.test(line)) inTopLevel = false
      return !(inTopLevel && new RegExp(`^${key}\\s*=`).test(line))
    })
    .join("\n")
}

function removeSection(text: string, section: string) {
  const lines = text.split(/\r?\n/)
  const header = `[${section}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start < 0) return text
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index
      break
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n")
}

function parseTomlStringArray(raw: string) {
  try {
    const parsed = JSON.parse(raw.trim()) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

function sectionStringArray(text: string, section: string, key: string) {
  const body = sectionBody(text, section)
  const match = body.match(new RegExp(`^${key}\\s*=\\s*(\\[[^\\n]*\\])\\s*$`, "m"))
  return match ? parseTomlStringArray(match[1]) : []
}

function sectionBoolean(text: string, section: string, key: string) {
  const body = sectionBody(text, section)
  const match = body.match(new RegExp(`^${key}\\s*=\\s*(true|false)\\s*$`, "m"))
  return match ? match[1] === "true" : undefined
}

function firstModelProviderId(text: string) {
  const match = text.match(/^\[model_providers\.([^\]\s]+)\]\s*$/m)
  return match ? match[1] : ""
}

function accessProviderId(text: string) {
  return topLevelString(text, "model_provider") || firstModelProviderId(text) || NEW_CONFIG_PROVIDER_ID
}

function providerBlock(providerId: string, baseUrl: string, providerName: string) {
  return [
    `[model_providers.${providerId}]`,
    `name = ${tomlString(providerName)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    `supports_websockets = false`,
  ].join("\n")
}

function selectedNodeCommand() {
  const candidates = [
    process.env.SWITCHGATE_MCP_NODE_PATH,
    process.env.NODE_PATH && process.execPath,
    process.execPath,
    "node",
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  return candidates[0]
}

function webSearchMcpEnvBlock(command: string) {
  const env: Record<string, string> = {
    CODEX_HOME: codexHome(),
  }
  if (process.execPath === command && process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1"
  }
  if (process.env.NODE_PATH) env.NODE_PATH = process.env.NODE_PATH.split(delimiter).join(delimiter)
  const entries = Object.entries(env)
  if (!entries.length) return ""
  return [
    `[mcp_servers.${WEB_SEARCH_MCP_SERVER_NAME}.env]`,
    ...entries.map(([key, value]) => `${key} = ${tomlString(value)}`),
  ].join("\n")
}

function webSearchMcpBlock() {
  const command = selectedNodeCommand()
  const scriptPath = webSearchMcpScriptPath()
  return [
    `[mcp_servers.${WEB_SEARCH_MCP_SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = ${JSON.stringify([scriptPath])}`,
    `startup_timeout_sec = 30`,
    `enabled = true`,
    "",
    webSearchMcpEnvBlock(command),
  ].filter(Boolean).join("\n")
}

function removeWebSearchMcpConfigText(current: string) {
  let next = removeSection(current, `mcp_servers.${WEB_SEARCH_MCP_SERVER_NAME}.env`)
  next = removeSection(next, `mcp_servers.${WEB_SEARCH_MCP_SERVER_NAME}`)
  return `${next.trimEnd()}\n`
}

function installWebSearchMcpConfigText(current: string) {
  const next = removeWebSearchMcpConfigText(current).trimEnd()
  return `${next ? `${next}\n\n` : ""}${webSearchMcpBlock()}\n`
}

function webSearchMcpStatus(text: string) {
  const section = `mcp_servers.${WEB_SEARCH_MCP_SERVER_NAME}`
  const command = sectionString(text, section, "command")
  const args = sectionStringArray(text, section, "args")
  const enabled = sectionBoolean(text, section, "enabled")
  const scriptPath = webSearchMcpScriptPath()
  return {
    serverName: WEB_SEARCH_MCP_SERVER_NAME,
    installed: Boolean(command && args.includes(scriptPath)),
    enabled: enabled !== false,
    command,
    args,
    scriptPath,
  }
}

function installConfigText(current: string, baseUrl: string, catalogPath: string) {
  const providerId = accessProviderId(current)
  const providerName =
    sectionString(current, `model_providers.${providerId}`, "name") || DEFAULT_PROVIDER_NAME
  let next = current.trimEnd()
  next = removeSection(next, `model_providers.${providerId}`).trimEnd()
  next = removeTopLevelKey(next, "model_catalog_json").trimEnd()
  next = upsertTopLevelString(next, "model_provider", providerId)
  next = upsertTopLevelString(next, "model", DEFAULT_MODEL)
  next = upsertTopLevelString(next, "model_catalog_json", catalogPath)
  next = upsertTopLevelStringIfMissing(next, "model_reasoning_effort", DEFAULT_REASONING)
  if (!/^disable_response_storage\s*=/m.test(next)) {
    next = `disable_response_storage = true\n${next}`
  }
  return `${next.trimEnd()}\n\n${providerBlock(providerId, baseUrl, providerName)}\n`
}

async function ensureAuthPlaceholder() {
  const path = authPath()
  if (!(await exists(path))) {
    await writeFile(path, `${JSON.stringify({ OPENAI_API_KEY: "codex-hot-switch-local" }, null, 2)}\n`, "utf8")
    return
  }
  const raw = await readFile(path, "utf8")
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error(`auth.json 不是合法 JSON：${path}`)
  }
  if (typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim()) return
  parsed.OPENAI_API_KEY = "codex-hot-switch-local"
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
}

export async function syncCodexModelCatalog(snapshot?: ConsoleSnapshot) {
  const current = snapshot ?? await getSnapshot()
  const path = modelCatalogPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify(buildCodexClientModelsResponse(current), null, 2)}\n`,
    "utf8",
  )
  return path
}

export async function getCodexConfigStatus(settings: Settings): Promise<CodexConfigStatus> {
  const home = codexHome()
  const config = configPath()
  const auth = authPath()
  const backup = backupPath()
  const backups = await listCodexConfigBackups(home)
  const catalog = modelCatalogPath()
  const text = await readTextIfExists(config)
  const currentProvider = topLevelString(text, "model_provider")
  const currentBaseUrl = currentProvider
    ? sectionString(text, `model_providers.${currentProvider}`, "base_url")
    : ""
  const expectedBaseUrl = targetBaseUrl(settings)
  const expectedProvider = accessProviderId(text)
  const expectedCatalogPath = modelCatalogPath()
  const currentModelCatalogPath = topLevelString(text, "model_catalog_json")
  const authText = await readTextIfExists(auth)
  let authReady = false
  if (authText) {
    try {
      const parsed = JSON.parse(authText) as Record<string, unknown>
      authReady = typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim().length > 0
    } catch {
      authReady = false
    }
  }

  return {
    codexHome: codexHome(),
    configPath: config,
    authPath: auth,
    backupPath: backup,
    backupRootPath: backup,
    modelCatalogPath: catalog,
    configExists: Boolean(text),
    authExists: Boolean(authText),
    backupExists: backups.length > 0,
    backups,
    modelCatalogExists: await exists(catalog),
    installed:
      Boolean(currentProvider) &&
      sameLocalBaseUrl(currentBaseUrl, expectedBaseUrl) &&
      (currentModelCatalogPath === MODEL_CATALOG_NAME ||
        currentModelCatalogPath === expectedCatalogPath) &&
      (await exists(catalog)),
    authReady,
    providerId: expectedProvider,
    currentProvider,
    currentModel: topLevelString(text, "model"),
    currentBaseUrl,
    currentModelCatalogPath,
    targetBaseUrl: expectedBaseUrl,
    targetModelCatalogPath: expectedCatalogPath,
    webSearchMcp: webSearchMcpStatus(text),
  }
}

export async function installCodexConfig(settings: Settings): Promise<CodexConfigMutationResult> {
  const config = configPath()
  await mkdir(dirname(config), { recursive: true })
  const current = await readTextIfExists(config)
  if (current) {
    await createCodexConfigBackup({
      codexHome: codexHome(),
      configPath: config,
      authPath: authPath(),
      note: "一键配置前自动备份",
    })
  }
  await ensureAuthPlaceholder()
  await syncCodexModelCatalog()
  const nextConfig = installWebSearchMcpConfigText(
    installConfigText(current, targetBaseUrl(settings), modelCatalogPath()),
  )
  await writeFile(
    config,
    nextConfig,
    "utf8",
  )
  return {
    status: await getCodexConfigStatus(settings),
    message: current
      ? "已写入 Codex 配置和 web_search MCP，并已创建配置前自动备份"
      : "已创建 Codex 配置和 web_search MCP",
  }
}

export async function backupCurrentCodexConfig(
  settings: Settings,
  note?: string,
): Promise<CodexConfigMutationResult> {
  const backup = await createCodexConfigBackup({
    codexHome: codexHome(),
    configPath: configPath(),
    authPath: authPath(),
    note,
  })
  return {
    status: await getCodexConfigStatus(settings),
    message: `已创建 Codex 配置备份：${backup.id}`,
  }
}

export async function restoreCodexConfig(
  settings: Settings,
  backupId?: string,
): Promise<CodexConfigMutationResult> {
  const backups = await listCodexConfigBackups(codexHome())
  const targetBackupId = backupId || backups[0]?.id
  if (!targetBackupId) {
    throw new Error("没有找到可恢复的 Codex 配置备份")
  }
  await restoreCodexConfigBackup({
    codexHome: codexHome(),
    configPath: configPath(),
    authPath: authPath(),
    backupId: targetBackupId,
  })
  return {
    status: await getCodexConfigStatus(settings),
    message: `已恢复 Codex 配置备份：${targetBackupId}`,
  }
}

export async function deleteCodexConfigBackupEntries(
  settings: Settings,
  backupIds: string[],
): Promise<CodexConfigMutationResult> {
  const deleted = await deleteCodexConfigBackups({ codexHome: codexHome(), backupIds })
  return {
    status: await getCodexConfigStatus(settings),
    message: `已删除 ${deleted} 个 Codex 配置备份`,
  }
}

export async function updateCodexConfigBackupEntryNote(
  settings: Settings,
  backupId: string,
  note: string,
): Promise<CodexConfigMutationResult> {
  await updateCodexConfigBackupNote({ codexHome: codexHome(), backupId, note })
  return {
    status: await getCodexConfigStatus(settings),
    message: "已更新备份备注",
  }
}

export async function installCodexWebSearchMcp(settings: Settings): Promise<CodexConfigMutationResult> {
  const config = configPath()
  await mkdir(dirname(config), { recursive: true })
  const current = await readTextIfExists(config)
  if (current) {
    await createCodexConfigBackup({
      codexHome: codexHome(),
      configPath: config,
      authPath: authPath(),
      note: "配置 web_search MCP 前自动备份",
    })
  }
  await writeFile(config, installWebSearchMcpConfigText(current), "utf8")
  return {
    status: await getCodexConfigStatus(settings),
    message: "已写入 SwitchGate web_search MCP 配置，重启 Codex 后生效",
  }
}

export async function removeCodexWebSearchMcp(settings: Settings): Promise<CodexConfigMutationResult> {
  const config = configPath()
  const current = await readTextIfExists(config)
  if (!current) {
    return {
      status: await getCodexConfigStatus(settings),
      message: "Codex 配置不存在，无需移除 web_search MCP",
    }
  }
  await createCodexConfigBackup({
    codexHome: codexHome(),
    configPath: config,
    authPath: authPath(),
    note: "移除 web_search MCP 前自动备份",
  })
  await writeFile(config, removeWebSearchMcpConfigText(current), "utf8")
  return {
    status: await getCodexConfigStatus(settings),
    message: "已移除 SwitchGate web_search MCP 配置，重启 Codex 后生效",
  }
}
