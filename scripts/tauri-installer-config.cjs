const fs = require("node:fs/promises")
const path = require("node:path")

function escapeNsisString(value) {
  return value.replaceAll("$", () => "$$")
}

async function createTauriInstallerConfig({
  tauriProjectDir,
  cargoTargetDir,
}) {
  const hooksTemplate = path.join(tauriProjectDir, "installer-hooks.nsh")
  const cleanupSource = path.join(tauriProjectDir, "installer-cleanup.ps1")
  const template = await fs.readFile(hooksTemplate, "utf8")
  const hooks = template.replace(
    "{{INSTALLER_CLEANUP_SOURCE}}",
    escapeNsisString(cleanupSource),
  )
  if (hooks.includes("{{INSTALLER_CLEANUP_SOURCE}}")) {
    throw new Error("NSIS 钩子模板中的清理脚本路径未替换")
  }
  const generatedDir = path.join(cargoTargetDir, "release", "nsis")
  const hooksPath = path.join(generatedDir, "switchgate-installer-hooks.nsh")
  const configPath = path.join(generatedDir, "switchgate-tauri-config.json")
  await fs.mkdir(generatedDir, { recursive: true })
  await fs.writeFile(hooksPath, hooks, "utf8")
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        bundle: {
          windows: {
            nsis: {
              installerHooks: hooksPath,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  return { configPath, hooksPath }
}

module.exports = {
  createTauriInstallerConfig,
  escapeNsisString,
}
