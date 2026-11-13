const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
  createTauriInstallerConfig,
  escapeNsisString,
} = require("./tauri-installer-config.cjs")

test("Tauri 安装器配置注入进程清理钩子", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "switchgate-installer-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const tauriProjectDir = path.join(root, "tauri")
  const cargoTargetDir = path.join(root, "target")
  await fs.mkdir(tauriProjectDir, { recursive: true })
  await fs.writeFile(
    path.join(tauriProjectDir, "installer-hooks.nsh"),
    '!define SOURCE "{{INSTALLER_CLEANUP_SOURCE}}"\n!define PRICE "$$5"\n',
    "utf8",
  )
  await fs.writeFile(
    path.join(tauriProjectDir, "installer-cleanup.ps1"),
    "param([string]$InstallDir)\n",
    "utf8",
  )

  const result = await createTauriInstallerConfig({
    tauriProjectDir,
    cargoTargetDir,
  })
  const config = JSON.parse(await fs.readFile(result.configPath, "utf8"))
  const hooks = await fs.readFile(result.hooksPath, "utf8")
  const cleanupSource = path.join(tauriProjectDir, "installer-cleanup.ps1")

  assert.equal(config.bundle.windows.nsis.installerHooks, result.hooksPath)
  assert.ok(hooks.includes(cleanupSource.replaceAll("$", "$$")))
  assert.doesNotMatch(hooks, /\{\{INSTALLER_CLEANUP_SOURCE\}\}/u)
  assert.ok(hooks.includes('!define PRICE "$$5"'))
})

test("NSIS 路径中的美元符号按 NSIS 语法转义", () => {
  assert.equal(escapeNsisString("C:\\price$\\setup.ps1"), "C:\\price$$" + "\\setup.ps1")
})
