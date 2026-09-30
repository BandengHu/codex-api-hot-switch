#!/usr/bin/env node
const { spawnSync } = require("node:child_process")
const fs = require("node:fs/promises")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const tauriProjectDir = path.join(root, "tauri", "src-tauri")
const cargoTargetDir = path.join(root, "dist", ".tauri-target")
const artifactDir = path.join(root, "dist", "tauri")
const cargoCommand = process.platform === "win32" ? "cargo.exe" : "cargo"

async function newestInstaller(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return ""
  }

  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".exe") continue
    const filePath = path.join(dir, entry.name)
    const stat = await fs.stat(filePath)
    candidates.push({ filePath, mtimeMs: stat.mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.filePath || ""
}

async function moveInstaller(source, destination) {
  await fs.rm(destination, { force: true })
  try {
    await fs.rename(source, destination)
  } catch (error) {
    if (error?.code !== "EXDEV") throw error
    await fs.copyFile(source, destination)
    await fs.rm(source, { force: true })
  }
}

async function stageInstaller() {
  const bundleDir = path.join(cargoTargetDir, "release", "bundle", "nsis")
  const installer = await newestInstaller(bundleDir)
  if (!installer) {
    throw new Error(`没有找到 Tauri NSIS 安装包：${bundleDir}`)
  }

  await fs.mkdir(artifactDir, { recursive: true })
  const destination = path.join(artifactDir, path.basename(installer))
  await moveInstaller(installer, destination)
  console.log(`Tauri 安装包：${path.relative(root, destination)}`)
}

function buildTauri() {
  const result = spawnSync(
    cargoCommand,
    ["tauri", "build", "--bundles", "nsis"],
    {
      cwd: tauriProjectDir,
      env: {
        ...process.env,
        CARGO_TARGET_DIR: cargoTargetDir,
        NODE_OPTIONS: "",
      },
      stdio: "inherit",
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`cargo tauri build 退出码 ${result.status ?? "unknown"}`)
  }
}

async function main() {
  if (!process.argv.includes("--stage-only")) {
    buildTauri()
  }
  await stageInstaller()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
