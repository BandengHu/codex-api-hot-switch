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

async function removePath(...parts) {
  await fs.rm(path.join(...parts), { recursive: true, force: true })
}

async function removeChildrenExcept(dir, keepNames) {
  if (!(await exists(dir))) return
  const keep = new Set(keepNames.map((name) => name.toLowerCase()))
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (keep.has(entry.name.toLowerCase())) continue
    await removePath(dir, entry.name)
  }
}

async function pruneStaticToolBinaries(dir) {
  if (!(await exists(dir))) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const hasWin32 = entries.some((entry) => entry.isDirectory() && entry.name.toLowerCase() === "win32")
  if (hasWin32) {
    await removeChildrenExcept(dir, ["win32"])
    await removeChildrenExcept(path.join(dir, "win32"), ["x64"])
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneStaticToolBinaries(path.join(dir, entry.name))
  }
}

async function pruneAllStaticToolBinaries(vendorDir) {
  const packageNames = new Set(["ffprobe-static", "ffmpeg-static"])
  const visit = async (dir) => {
    if (!(await exists(dir))) return
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const child = path.join(dir, entry.name)
      if (packageNames.has(entry.name.toLowerCase())) {
        await pruneStaticToolBinaries(path.join(child, "bin"))
        continue
      }
      await visit(child)
    }
  }
  await visit(vendorDir)
}

async function pruneDuplicatedTopLevelVendorPackages(vendorDir) {
  if (!(await exists(path.join(vendorDir, ".pnpm")))) return
  // packagedNodePath 会把 vendor/.pnpm/*/node_modules 全部加入 NODE_PATH。
  // 顶层包多数只是 .pnpm 内容的重复拷贝。保留 tsx，因为企业微信启动器会显式读取
  // vendor/tsx/dist/loader.mjs 作为 --import loader。
  const keepTopLevel = new Set([".pnpm", "tsx"])
  for (const entry of await fs.readdir(vendorDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (keepTopLevel.has(entry.name.toLowerCase())) continue
    await removePath(vendorDir, entry.name)
  }
}

async function prunePackagedVendor(vendorDir) {
  // 只发布 Windows x64 安装包，裁掉静态工具里的其它平台/架构二进制。
  await pruneAllStaticToolBinaries(vendorDir)

  // better-sqlite3 运行只需要 .node 原生模块，源码、构建中间文件和静态库很占空间。
  for (const relativePath of [
    ["better-sqlite3", "deps"],
    ["better-sqlite3", "src"],
    ["better-sqlite3", "build", "Release", "obj"],
    ["better-sqlite3", "build", "Release", "better_sqlite3.iobj"],
    ["better-sqlite3", "build", "Release", "better_sqlite3.ipdb"],
    ["better-sqlite3", "build", "Release", "sqlite3.lib"],
    ["better-sqlite3", "build", "Release", "test_extension.iobj"],
    ["better-sqlite3", "build", "Release", "test_extension.node"],
    ["better-sqlite3", "build", "deps"],
    ["better-sqlite3", "build", "better_sqlite3.vcxproj"],
    ["better-sqlite3", "build", "test_extension.vcxproj"],
  ]) {
    await removePath(vendorDir, ...relativePath)
  }

  // 移除不会被运行时 require 的测试、示例、源码映射和 Markdown 文档。
  await pruneNonRuntimeFiles(vendorDir)
  await pruneDuplicatedTopLevelVendorPackages(vendorDir)
}

async function pruneNonRuntimeFiles(dir) {
  if (!(await exists(dir))) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const lower = entry.name.toLowerCase()
    if (entry.isDirectory()) {
      if (["test", "tests", "__tests__", "example", "examples", "benchmark", "benchmarks", "docs"].includes(lower)) {
        await removePath(fullPath)
        continue
      }
      await pruneNonRuntimeFiles(fullPath)
      continue
    }
    if (
      lower.endsWith(".map") ||
      lower.endsWith(".md") ||
      lower === "license" ||
      lower.startsWith("license.") ||
      lower === "changelog" ||
      lower.startsWith("changelog.") ||
      lower === "readme" ||
      lower.startsWith("readme.")
    ) {
      await removePath(fullPath)
    }
  }
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
  await prunePackagedVendor(path.join(electronServerDir, "vendor"))

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
