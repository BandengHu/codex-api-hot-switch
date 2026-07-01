const fs = require("node:fs/promises")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const standaloneDir = path.join(root, ".next", "standalone")
const electronServerDir = path.join(root, ".electron-server")
const electronShellDir = path.join(root, ".electron-shell")

const tracedBuildArtifacts = [
  ".data",
  ".electron-server",
  ".electron-shell",
  ".tmp",
  "dist",
  "win-unpacked",
  "builder-debug.yml",
  "tsconfig.tsbuildinfo",
]

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function copyDir(from, to) {
  await fs.rm(to, { recursive: true, force: true })
  await fs.cp(from, to, { recursive: true })
}

async function main() {
  await fs.rm(electronServerDir, { recursive: true, force: true })
  await fs.rm(electronShellDir, { recursive: true, force: true })

  if (!(await exists(path.join(standaloneDir, "server.js")))) {
    throw new Error("缺少 .next/standalone/server.js，请先运行 next build")
  }

  for (const artifact of tracedBuildArtifacts) {
    await fs.rm(path.join(standaloneDir, artifact), { recursive: true, force: true })
  }
  await copyDir(path.join(root, ".next", "static"), path.join(standaloneDir, ".next", "static"))
  await copyDir(path.join(root, "public"), path.join(standaloneDir, "public"))

  await fs.cp(standaloneDir, electronServerDir, {
    recursive: true,
    dereference: true,
  })
  await fs.mkdir(path.join(electronServerDir, "scripts"), { recursive: true })
  for (const runner of [
    "codex-desktop-plugins-runner.cjs",
    "codex-desktop-model-whitelist-runner.cjs",
  ]) {
    await fs.copyFile(
      path.join(root, "scripts", runner),
      path.join(electronServerDir, "scripts", runner),
    )
  }
  if (await exists(path.join(root, "integrations", "codexbridge"))) {
    await copyDir(
      path.join(root, "integrations", "codexbridge"),
      path.join(electronServerDir, "integrations", "codexbridge"),
    )
  }
  await fs.rename(
    path.join(electronServerDir, "node_modules"),
    path.join(electronServerDir, "vendor"),
  )

  await copyDir(path.join(root, "electron"), path.join(electronShellDir, "electron"))
  await fs.mkdir(path.join(electronShellDir, "node_modules"), { recursive: true })
  await fs.writeFile(
    path.join(electronShellDir, "node_modules", ".keep"),
    "\n",
    "utf8",
  )
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
  const shellPackage = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    author: pkg.author,
    main: pkg.main,
    dependencies: {},
  }
  await fs.writeFile(
    path.join(electronShellDir, "package.json"),
    `${JSON.stringify(shellPackage, null, 2)}\n`,
    "utf8",
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
