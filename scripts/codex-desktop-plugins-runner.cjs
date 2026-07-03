const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const BUNDLED_MARKETPLACE_ID = "openai-bundled"
const CHROME_EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg"
const NATIVE_HOST_NAME = "com.openai.codexextension"
const PLUGINS = [
  { id: "browser", label: "浏览器", required: [".codex-plugin/plugin.json"] },
  {
    id: "chrome",
    label: "Chrome",
    required: [
      ".codex-plugin/plugin.json",
      "scripts/browser-client.mjs",
      "extension-host/windows/x64/extension-host.exe",
    ],
  },
  { id: "computer-use", label: "电脑", required: [".codex-plugin/plugin.json"] },
]

function codexHome() {
  return process.env.CODEX_HOME || path.join(process.env.USERPROFILE || os.homedir(), ".codex")
}

function configPath() {
  return path.join(codexHome(), "config.toml")
}

function stableMarketplacePath() {
  return path.join(codexHome(), "plugins", "marketplace-source", BUNDLED_MARKETPLACE_ID)
}

function pluginLatestPath(id) {
  return path.join(codexHome(), "plugins", "cache", BUNDLED_MARKETPLACE_ID, id, "latest")
}

function chromeLatestPath() {
  return pluginLatestPath("chrome")
}

function chromeNativeHostsPath() {
  return path.join(codexHome(), "chrome-native-hosts.json")
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
}

function chromeManifestPath() {
  return path.join(localAppData(), "OpenAI", "extension", `${NATIVE_HOST_NAME}.json`)
}

function uniquePaths(paths) {
  const seen = new Set()
  const result = []
  for (const filePath of paths) {
    if (!filePath) continue
    const key = normalizeSlashes(path.resolve(filePath)).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(filePath)
  }
  return result
}

function windowsAppsRoots() {
  return uniquePaths([
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "WindowsApps") : "",
    process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, "WindowsApps") : "",
    "C:\\Program Files\\WindowsApps",
  ])
}

function codexBinRoot() {
  return path.join(localAppData(), "OpenAI", "Codex", "bin")
}

function standaloneCodexCandidateRoots() {
  return uniquePaths([
    path.join(localAppData(), "OpenAI", "Codex", "bin"),
    path.join(localAppData(), "OpenAI", "Codex"),
    path.join(localAppData(), "Programs", "OpenAI", "Codex"),
  ])
}

async function exists(filePath) {
  try {
    await fs.stat(filePath)
    return true
  } catch {
    return false
  }
}

async function readTextIfExists(filePath) {
  return (await exists(filePath)) ? await fs.readFile(filePath, "utf8") : ""
}

async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function pluginPath(root, id) {
  return root ? path.join(root, "plugins", id) : ""
}

async function pluginVersionFromMarketplace(root) {
  const value = await readJsonIfExists(
    path.join(root, "plugins", "chrome", ".codex-plugin", "plugin.json"),
  )
  return typeof value?.version === "string" && value.version.trim()
    ? value.version.trim()
    : ""
}

function normalizeSlashes(value) {
  return value.replaceAll("\\", "/")
}

function samePath(left, right) {
  if (!left || !right) return false
  return normalizeSlashes(left).toLowerCase() === normalizeSlashes(right).toLowerCase()
}

function sectionBody(text, section) {
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

function sectionString(text, section, key) {
  const body = sectionBody(text, section)
  const match = body.match(new RegExp(`^${key}\\s*=\\s*(['"])(.*?)\\1\\s*$`, "m"))
  return match?.[2] || ""
}

function pluginEnabled(text, pluginId) {
  const body = sectionBody(text, `plugins."${pluginId}@${BUNDLED_MARKETPLACE_ID}"`)
  if (!body) return false
  return /^enabled\s*=\s*true\s*$/m.test(body)
}

function upsertSection(text, section, bodyLines) {
  const lines = text.split(/\r?\n/)
  const header = `[${section}]`
  const start = lines.findIndex((line) => line.trim() === header)
  const block = [header, ...bodyLines]
  if (start < 0) return `${text.trimEnd()}\n\n${block.join("\n")}\n`
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index
      break
    }
  }
  return [...lines.slice(0, start), ...block, ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

function removeSection(text, section) {
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
  return [...lines.slice(0, start), ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

function tomlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

function parseVersionFromInstallPath(filePath) {
  const match = filePath.match(/OpenAI\.Codex_(.+?)_x64__/i)
  return match?.[1] || ""
}

async function resourcesPathFromInstallPath(installPath) {
  if (!installPath) return ""
  for (const candidate of uniquePaths([
    path.join(installPath, "app", "resources"),
    path.join(installPath, "resources"),
    path.join(installPath, "..", "resources"),
    path.join(installPath, "..", "app", "resources"),
  ])) {
    if (await exists(candidate)) return candidate
  }
  return ""
}

async function bundledMarketplacePathFromInstallPath(installPath) {
  const resourcesPath = await resourcesPathFromInstallPath(installPath)
  return resourcesPath ? path.join(resourcesPath, "plugins", BUNDLED_MARKETPLACE_ID) : ""
}

async function listWindowsAppCodexInstallPaths() {
  const candidates = []
  for (const root of windowsAppsRoots()) {
    let entries = []
    try {
      entries = await fs.readdir(root)
    } catch {
      continue
    }
    for (const name of entries) {
      if (/^OpenAI\.Codex_.+_x64__/i.test(name)) {
        candidates.push(path.join(root, name))
      }
    }
  }
  return uniquePaths(candidates).sort((a, b) =>
    parseVersionFromInstallPath(b).localeCompare(
      parseVersionFromInstallPath(a),
      undefined,
      { numeric: true },
    ),
  )
}

async function normalizeStandaloneCodexPath(candidate) {
  if (!candidate) return ""
  const base = path.basename(candidate).toLowerCase()
  if ((base === "codex.exe" || base === "codex") && (await exists(candidate))) {
    return path.dirname(candidate)
  }
  for (const appDir of uniquePaths([
    candidate,
    path.join(candidate, "app"),
  ])) {
    if (
      (await exists(path.join(appDir, "Codex.exe"))) ||
      (await exists(path.join(appDir, "codex.exe")))
    ) {
      return appDir
    }
  }
  return ""
}

async function listStandaloneCodexInstallPaths() {
  const paths = []
  for (const candidate of standaloneCodexCandidateRoots()) {
    const appDir = await normalizeStandaloneCodexPath(candidate)
    if (!appDir) continue
    paths.push(appDir)
  }
  return uniquePaths(paths)
}

function installKindFromPath(installPath) {
  if (!installPath) return ""
  return /[\\/]WindowsApps[\\/]OpenAI\.Codex_/i.test(installPath)
    ? "WindowsApps"
    : "Standalone"
}

async function listLatestCodexInstallPath() {
  const candidates = [
    ...(await listWindowsAppCodexInstallPaths()),
    ...(await listStandaloneCodexInstallPaths()),
  ]

  for (const candidate of candidates) {
    const bundled = await bundledMarketplacePathFromInstallPath(candidate)
    if (bundled && (await exists(bundled))) return candidate
  }
  return candidates[0] || ""
}

async function firstExisting(paths) {
  for (const candidate of paths) {
    if (await exists(candidate)) return candidate
  }
  return ""
}

async function runtimeToolPaths() {
  const binRoot = codexBinRoot()
  return {
    codexCliPath: await firstExisting([
      path.join(binRoot, "codex.exe"),
      path.join(binRoot, "38dff8711e296435", "codex.exe"),
    ]),
    nodePath: await firstExisting([
      path.join(binRoot, "node.exe"),
      path.join(binRoot, "5b9024f90663758b", "node.exe"),
    ]),
    nodeReplPath: await firstExisting([
      path.join(binRoot, "node_repl.exe"),
      path.join(binRoot, "34ab3e1324cc55b5", "node_repl.exe"),
    ]),
  }
}

async function requiredFilesOk(root, id) {
  const plugin = PLUGINS.find((item) => item.id === id)
  if (!plugin || !root) return false
  for (const relative of plugin.required) {
    if (!(await exists(path.join(pluginPath(root, id), relative)))) return false
  }
  return true
}

async function cacheLatestOk(id) {
  const latest = pluginLatestPath(id)
  if (!(await exists(path.join(latest, ".codex-plugin", "plugin.json")))) return false
  if (id !== "chrome") return true
  return (
    (await exists(path.join(latest, "scripts", "browser-client.mjs"))) &&
    (await exists(
      path.join(latest, "extension-host", "windows", "x64", "extension-host.exe"),
    ))
  )
}

async function pluginChecks(configText, root) {
  const checks = []
  for (const plugin of PLUGINS) {
    checks.push({
      id: plugin.id,
      label: plugin.label,
      enabled: pluginEnabled(configText, plugin.id),
      sourceExists: await exists(pluginPath(root, plugin.id)),
      requiredFilesOk: await requiredFilesOk(root, plugin.id),
      cacheLatestOk: await cacheLatestOk(plugin.id),
    })
  }
  return checks
}

async function chromeNativeHostOk(expectedVersion, paths) {
  const value = await readJsonIfExists(chromeNativeHostsPath())
  const entry = value?.chromeNativeHosts?.[0]
  if (!entry) return false
  return (
    entry.pluginVersion === expectedVersion &&
    entry.codexCliPath === paths.codexCliPath &&
    typeof entry.browserClientPath === "string" &&
    typeof entry.extensionHostPath === "string" &&
    (await exists(entry.browserClientPath)) &&
    (await exists(entry.extensionHostPath)) &&
    (!entry.nodePath || (await exists(String(entry.nodePath)))) &&
    (!entry.nodeReplPath || (await exists(String(entry.nodeReplPath))))
  )
}

async function chromeManifestOk() {
  const value = await readJsonIfExists(chromeManifestPath())
  const expectedPath = path.join(
    chromeLatestPath(),
    "extension-host",
    "windows",
    "x64",
    "extension-host.exe",
  )
  return Boolean(value?.path && samePath(value.path, expectedPath) && (await exists(value.path)))
}

async function getStatus() {
  const latestInstallPath = await listLatestCodexInstallPath()
  const latestInstallVersion = parseVersionFromInstallPath(latestInstallPath)
  const latestInstallKind = installKindFromPath(latestInstallPath)
  const latestResourcesPath = latestInstallPath
    ? await resourcesPathFromInstallPath(latestInstallPath)
    : ""
  const latestBundledMarketplacePath = latestResourcesPath
    ? path.join(latestResourcesPath, "plugins", BUNDLED_MARKETPLACE_ID)
    : ""
  const configText = await readTextIfExists(configPath())
  const expectedPluginVersion =
    (await pluginVersionFromMarketplace(latestBundledMarketplacePath)) ||
    (await pluginVersionFromMarketplace(stableMarketplacePath()))
  const activeMarketplaceSource = sectionString(
    configText,
    `marketplaces.${BUNDLED_MARKETPLACE_ID}`,
    "source",
  )
  const configuredMarketplaceSource = activeMarketplaceSource
  const stablePath = stableMarketplacePath()
  const rootForChecks = activeMarketplaceSource || stablePath
  const paths = await runtimeToolPaths()
  const plugins = await pluginChecks(configText, rootForChecks)
  const chromeHostOk = await chromeNativeHostOk(expectedPluginVersion, paths)
  const manifestOk = await chromeManifestOk()
  const stableComplete = await requiredFilesOk(stablePath, "chrome")
  const issues = []

  if (!latestBundledMarketplacePath || !(await exists(latestBundledMarketplacePath))) {
    issues.push("没有找到 Codex 官方 bundled 插件源")
  }
  if (!stableComplete) {
    issues.push("稳定 openai-bundled 插件源尚未准备完整")
  }
  for (const plugin of plugins) {
    if (!plugin.enabled) issues.push(`${plugin.label} 插件未启用`)
    if (!plugin.requiredFilesOk) issues.push(`${plugin.label} 插件文件不完整`)
    if (!plugin.cacheLatestOk) issues.push(`${plugin.label} 缓存 latest 指向不完整`)
  }
  if (!chromeHostOk) issues.push("Chrome native host 配置需要修复")
  if (!manifestOk) issues.push("Chrome native messaging manifest 不可用")
  if (!paths.codexCliPath) issues.push("没有找到 Codex CLI 可执行文件")
  const notes = [
    "本工具只修复 bundled 插件文件、latest 缓存、Chrome native host 与 manifest；不会注入或篡改 Codex 桌面端插件 UI。",
    "如果这里全部健康但 @Chrome 仍不显示，通常是 Codex 桌面端登录态、API 模式或前端过滤导致，需要从桌面端插件页启用或重启桌面端验证。",
  ]

  return {
    codexHome: codexHome(),
    configPath: configPath(),
    stableMarketplacePath: stablePath,
    activeMarketplaceSource,
    hasManualBundledMarketplace: Boolean(configuredMarketplaceSource),
    activeMarketplaceSourceExists: Boolean(activeMarketplaceSource && (await exists(activeMarketplaceSource))),
    activeMarketplaceUsesStableSource: Boolean(configuredMarketplaceSource && samePath(activeMarketplaceSource, stablePath)),
    latestInstallPath,
    latestInstallVersion,
    latestInstallKind,
    latestResourcesPath,
    latestBundledMarketplacePath,
    latestBundledMarketplaceExists: Boolean(
      latestBundledMarketplacePath && (await exists(latestBundledMarketplacePath)),
    ),
    stableMarketplaceExists: await exists(stablePath),
    stableMarketplaceComplete: stableComplete,
    chromeNativeHostsPath: chromeNativeHostsPath(),
    chromeNativeHostsExists: await exists(chromeNativeHostsPath()),
    chromeNativeHostOk: chromeHostOk,
    chromeManifestPath: chromeManifestPath(),
    chromeManifestExists: await exists(chromeManifestPath()),
    chromeManifestOk: manifestOk,
    codexCliPath: paths.codexCliPath,
    codexCliExists: Boolean(paths.codexCliPath && (await exists(paths.codexCliPath))),
    nodePath: paths.nodePath,
    nodeExists: Boolean(paths.nodePath && (await exists(paths.nodePath))),
    nodeReplPath: paths.nodeReplPath,
    nodeReplExists: Boolean(paths.nodeReplPath && (await exists(paths.nodeReplPath))),
    plugins,
    healthy: issues.length === 0,
    issues,
    notes,
  }
}

async function backupExisting(filePath, backupDir) {
  if (!(await exists(filePath))) return
  await fs.mkdir(backupDir, { recursive: true })
  await fs.copyFile(filePath, path.join(backupDir, path.basename(filePath)))
}

function isWindowsBusyError(error) {
  return ["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function rmWithRetries(target) {
  let lastError
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      if (!isWindowsBusyError(error)) throw error
      await delay(250 + attempt * 250)
    }
  }
  throw lastError
}

function stopChromeNativeHostProcesses() {
  const needles = [
    path.join(chromeLatestPath(), "extension-host", "windows", "x64"),
    path.join(stableMarketplacePath(), "plugins", "chrome", "extension-host", "windows", "x64"),
  ]
  const script = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$needles = ConvertFrom-Json -InputObject $env:CODEX_CHROME_HOST_NEEDLES
$matches = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $process = $_
  $hit = $false
  foreach ($needle in $needles) {
    if ([string]::IsNullOrWhiteSpace($needle)) { continue }
    if ($process.ExecutablePath -and $process.ExecutablePath.StartsWith($needle, [System.StringComparison]::OrdinalIgnoreCase)) {
      $hit = $true
      break
    }
    if ($process.CommandLine -and $process.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $hit = $true
      break
    }
  }
  if (-not $hit) { return }
  $matches[[string]$process.ProcessId] = $process
  if ($process.ParentProcessId) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)" -ErrorAction SilentlyContinue
    if ($parent -and $parent.Name -ieq "cmd.exe" -and $parent.CommandLine -and $parent.CommandLine.IndexOf("extension-host", [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $matches[[string]$parent.ProcessId] = $parent
    }
  }
}
$stopped = @()
$failed = @()
$matches.Values | Sort-Object ProcessId -Descending | ForEach-Object {
  $processId = [int]$_.ProcessId
  try {
    $liveProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $liveProcess) { return }
    Stop-Process -Id $processId -Force -ErrorAction Stop
    $stopped += [pscustomobject]@{
      processId = $processId
      name = $_.Name
      executablePath = $_.ExecutablePath
    }
  } catch {
    if ($_.Exception.Message -match "Cannot find a process with the process identifier") { return }
    $failed += [pscustomobject]@{
      processId = $processId
      name = $_.Name
      message = $_.Exception.Message
    }
  }
}
Start-Sleep -Milliseconds 500
[pscustomobject]@{
  stopped = $stopped
  failed = $failed
} | ConvertTo-Json -Compress -Depth 5
`
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_CHROME_HOST_NEEDLES: JSON.stringify(needles),
    },
  })
  if (result.status !== 0) {
    throw new Error(
      [
        "无法停止 Chrome native host 进程。",
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }
  const parsed = JSON.parse(result.stdout.trim() || '{"stopped":[],"failed":[]}')
  if (parsed.failed?.length) {
    throw new Error(`无法停止 Chrome native host 进程：${JSON.stringify(parsed.failed)}`)
  }
  return parsed.stopped || []
}

async function writeConfigPluginSettings(backupDir) {
  const filePath = configPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await backupExisting(filePath, backupDir)
  let next = removeSection(
    await readTextIfExists(filePath),
    `marketplaces.${BUNDLED_MARKETPLACE_ID}`,
  )
  for (const plugin of PLUGINS) {
    next = upsertSection(next, `plugins."${plugin.id}@${BUNDLED_MARKETPLACE_ID}"`, [
      "enabled = true",
    ])
  }
  await fs.writeFile(filePath, `${next.trimEnd()}\n`, "utf8")
}

async function repairPluginLatest(id, stablePluginPath) {
  const latest = pluginLatestPath(id)
  await fs.mkdir(path.dirname(latest), { recursive: true })
  if (await exists(latest)) {
    await rmWithRetries(latest)
  }
  try {
    await fs.symlink(stablePluginPath, latest, "junction")
  } catch {
    await fs.mkdir(latest, { recursive: true })
    await fs.cp(stablePluginPath, latest, { recursive: true, force: true })
  }
}

async function writeChromeNativeHosts(version, paths, backupDir) {
  const filePath = chromeNativeHostsPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await backupExisting(filePath, backupDir)
  const installPath = await listLatestCodexInstallPath()
  const resourcesPath = installPath ? await resourcesPathFromInstallPath(installPath) : ""
  const browserClientPath = path.join(chromeLatestPath(), "scripts", "browser-client.mjs")
  const extensionHostPath = path.join(
    chromeLatestPath(),
    "extension-host",
    "windows",
    "x64",
    "extension-host.exe",
  )
  const value = {
    schemaVersion: 1,
    chromeNativeHosts: [
      {
        schemaVersion: 1,
        browserClientPath,
        codexCliPath: paths.codexCliPath,
        codexHome: codexHome(),
        extensionHostPath,
        extensionIds: [CHROME_EXTENSION_ID],
        nativeHostName: NATIVE_HOST_NAME,
        nodePath: paths.nodePath,
        nodeReplPath: paths.nodeReplPath,
        pluginVersion: version,
        proxyHost: "127.0.0.1",
        proxyPort: 0,
        resourcesPath,
        updatedAt: new Date().toISOString(),
      },
    ],
  }
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function writeChromeManifest(backupDir) {
  const filePath = chromeManifestPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await backupExisting(filePath, backupDir)
  const value = {
    allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
    description: "Codex chrome native messaging host",
    name: NATIVE_HOST_NAME,
    path: path.join(
      chromeLatestPath(),
      "extension-host",
      "windows",
      "x64",
      "extension-host.exe",
    ),
    type: "stdio",
  }
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function repair() {
  const latestInstallPath = await listLatestCodexInstallPath()
  if (!latestInstallPath) throw new Error("没有找到当前 Codex 桌面端安装目录")
  const bundled = await bundledMarketplacePathFromInstallPath(latestInstallPath)
  if (!(await exists(bundled))) throw new Error(`当前 Codex 安装包缺少 bundled 插件源：${bundled}`)
  if (!(await requiredFilesOk(bundled, "chrome"))) {
    throw new Error("当前 Codex 安装包内的 Chrome 插件不完整，无法作为修复源")
  }

  const backupDir = path.join(
    codexHome(),
    `backup-codex-desktop-plugins-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  )
  const stoppedHostProcesses = stopChromeNativeHostProcesses()
  const stable = stableMarketplacePath()
  await rmWithRetries(stable)
  await fs.mkdir(path.dirname(stable), { recursive: true })
  await fs.cp(bundled, stable, { recursive: true, force: true })
  await writeConfigPluginSettings(backupDir)
  stopChromeNativeHostProcesses()
  for (const plugin of PLUGINS) {
    await repairPluginLatest(plugin.id, path.join(stable, "plugins", plugin.id))
  }

  await writeChromeNativeHosts(
    (await pluginVersionFromMarketplace(stable)) || parseVersionFromInstallPath(latestInstallPath),
    await runtimeToolPaths(),
    backupDir,
  )
  await writeChromeManifest(backupDir)

  return {
    status: await getStatus(),
    message: "已修复 Codex 桌面端 bundled 插件路径，请完全退出并重启 Codex 桌面端。",
    backupDir,
    stoppedHostProcesses,
  }
}

async function main() {
  const action = process.argv[2]
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(await getStatus())}\n`)
    return
  }
  if (action === "repair") {
    process.stdout.write(`${JSON.stringify(await repair())}\n`)
    return
  }
  throw new Error(`未知 Codex 桌面端插件动作：${action || ""}`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
