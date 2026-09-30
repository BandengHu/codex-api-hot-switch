#!/usr/bin/env node
/**
 * 为 Tauri 外壳准备随包资源。
 *
 * 与 Electron 那条链路（scripts/prepare-electron-build.cjs）的核心差异：
 *
 * - Electron 把 server 塞进 app.asar，再把必须真实落盘的条目通过 asarUnpack 解出来；
 *   Tauri 没有 asar 概念，resources 目录天然就是真实文件，所以这里**只需要拷贝**，
 *   不需要 asarUnpack 那套断言与映射。
 * - Electron 里 `electron.exe` 兼任 Node，所以 vendor 可以留在 asar 内靠 NODE_PATH 解析；
 *   Tauri 用的是宿主机 Node，路径解析没有任何特殊机制，同样走 NODE_PATH 即可。
 *
 * 复用 prepare-electron-build.cjs 里的裁剪逻辑（语言包不适用，但 vendor 裁剪适用），
 * 因此这里直接 require 它导出的函数 —— 但那个文件是「执行即跑」的脚本，
 * 所以下面把需要的裁剪步骤按同样顺序复刻一遍，保持两边行为一致。
 */

const fs = require("node:fs/promises")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const standaloneDir = path.join(root, ".next", "standalone")
const tauriResourcesDir = path.join(root, "tauri", "src-tauri", "resources")
const targetServerDir = path.join(tauriResourcesDir, "server")

// 与 Electron 链路保持一致：构建产物本身不能进包
const tracedBuildArtifacts = [
  ".data",
  ".electron-shell",
  ".tmp",
  "dist",
  "win-unpacked",
  "builder-debug.yml",
  "tsconfig.tsbuildinfo",
]

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function copyDir(from, to) {
  await fs.rm(to, { recursive: true, force: true })
  await fs.cp(from, to, { recursive: true, dereference: true })
}

const STATIC_TOOL_PACKAGE_NAMES = new Set(["ffprobe-static", "ffmpeg-static"])

async function forEachStaticToolBinDir(dir, handler) {
  if (!(await exists(dir))) return
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = path.join(dir, entry.name)
    if (STATIC_TOOL_PACKAGE_NAMES.has(entry.name.toLowerCase())) {
      await handler(path.join(child, "bin"))
      continue
    }
    await forEachStaticToolBinDir(child, handler)
  }
}

async function removeChildrenExcept(dir, keepNames) {
  if (!(await exists(dir))) return
  const keep = new Set(keepNames.map((n) => n.toLowerCase()))
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (keep.has(entry.name.toLowerCase())) continue
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true })
  }
}

async function pruneStaticToolBinaries(dir) {
  if (!(await exists(dir))) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const hasWin32 = entries.some(
    (e) => e.isDirectory() && e.name.toLowerCase() === "win32",
  )
  if (hasWin32) {
    await removeChildrenExcept(dir, ["win32"])
    await removeChildrenExcept(path.join(dir, "win32"), ["x64"])
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await pruneStaticToolBinaries(path.join(dir, entry.name))
  }
}

async function pruneAllStaticToolBinaries(nodeModulesDir) {
  await forEachStaticToolBinDir(nodeModulesDir, pruneStaticToolBinaries)
}

async function pruneNonRuntimeFiles(dir) {
  if (!(await exists(dir))) return
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const lower = entry.name.toLowerCase()
    if (entry.isDirectory()) {
      if (
        ["test", "tests", "__tests__", "example", "examples", "benchmark", "benchmarks", "docs"].includes(lower)
      ) {
        await fs.rm(full, { recursive: true, force: true })
        continue
      }
      await pruneNonRuntimeFiles(full)
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
      await fs.rm(full, { recursive: true, force: true })
    }
  }
}

/**
 * vendor 顶层包多是 .pnpm 内容的重复拷贝；保留 tsx（企业微信启动器会读
 * vendor/tsx/dist/loader.mjs 作为 --import loader）。
 */
async function pruneDuplicatedTopLevelVendorPackages(vendorDir) {
  if (!(await exists(path.join(vendorDir, ".pnpm")))) return
  const keep = new Set([".pnpm", "tsx"])
  for (const entry of await fs.readdir(vendorDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (keep.has(entry.name.toLowerCase())) continue
    await fs.rm(path.join(vendorDir, entry.name), { recursive: true, force: true })
  }
}

/**
 * 删掉 .pnpm 链接农场。
 *
 * 为什么 Tauri 链路能删、Electron 链路不能：
 *
 * - **超长路径**。pnpm 的目录名把 peer 依赖校验和嵌了进去，例如
 *   `.pnpm/next@16.2.6_@babel+core@7.2_40a7effce8bcad24669d45809ebe449e/node_modules/@swc/helpers/...`。
 *   实测本包里有 **146 个条目**的绝对路径超过 Windows 的 260 字符上限（最长 291），
 *   NSIS 的 makensis 遇到就打不开文件并**整体中止**打包。Electron 走 asar，不展开真实路径，
 *   所以从来没暴露过这个问题。
 * - **它其实是冗余的**。实测把 .pnpm 整个移走后，`node server.js` 照常启动，
 *   16 个 API 路由全部返回 200/405，0 个 5xx，日志里还能看到
 *   `ExperimentalWarning: SQLite is an experimental feature`（说明 node:sqlite 真的加载了）。
 *   Next standalone 已经把运行时依赖 bundle 进了 `.next/server/chunks`，
 *   .pnpm 只是 pnpm 布局的残留。
 * - 保留顶层 `tsx`（企业微信启动器会读 `vendor/tsx/dist/loader.mjs` 当 --import loader）。
 */
async function prunePnpmStore(vendorDir) {
  const store = path.join(vendorDir, ".pnpm")
  if (!(await exists(store))) return
  await fs.rm(store, { recursive: true, force: true })
}

async function pruneVendor(vendorDir) {
  // 注意顺序：先清顶层重复包（此时 .pnpm 还在，函数内依赖它判断），
  // 再删 .pnpm 链接农场，否则 pruneDuplicatedTopLevelVendorPackages 会直接短路。
  await pruneAllStaticToolBinaries(vendorDir)
  await pruneNonRuntimeFiles(vendorDir)
  for (const rel of [
    ["better-sqlite3", "deps"],
    ["better-sqlite3", "src"],
    ["better-sqlite3", "build", "Release", "obj"],
    ["better-sqlite3", "build", "Release", "sqlite3.lib"],
    ["better-sqlite3", "build", "deps"],
  ]) {
    await fs.rm(path.join(vendorDir, ...rel), { recursive: true, force: true })
  }
  await pruneDuplicatedTopLevelVendorPackages(vendorDir)
  await prunePnpmStore(vendorDir)
}

/**
 * 打包前的护栏：确认资源树里没有超过 Windows 260 字符上限的路径。
 *
 * NSIS 的 makensis 打不开超长路径的文件时会直接中止整个打包，报错信息还很隐晦
 * （“failed opening file ... -- aborting creation process”）。与其等打包跑十几分钟
 * 再失败，不如在这里秒级拦下来并打印最长的几个 offender。
 */
async function assertNoLongPaths(root, limit = 250) {
  const offenders = []
  let maxLen = 0

  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (full.length > maxLen) maxLen = full.length
      if (full.length > limit && offenders.length < 10) {
        offenders.push(`${full.length}  ${path.relative(root, full)}`)
      }
      if (entry.isDirectory()) await walk(full)
    }
  }

  await walk(root)
  if (offenders.length > 0) {
    throw new Error(
      `检测到超长路径（> ${limit} 字符），NSIS 打包会失败。最长 ${maxLen}。\n` +
        offenders.map((o) => `  ${o}`).join("\n"),
    )
  }
  return maxLen
}

async function main() {
  if (!(await exists(path.join(standaloneDir, "server.js")))) {
    throw new Error("缺少 .next/standalone/server.js，请先运行 next build")
  }

  await fs.rm(tauriResourcesDir, { recursive: true, force: true })
  await fs.mkdir(tauriResourcesDir, { recursive: true })

  for (const artifact of tracedBuildArtifacts) {
    await fs.rm(path.join(standaloneDir, artifact), { recursive: true, force: true })
  }
  await copyDir(
    path.join(root, ".next", "server", "chunks"),
    path.join(standaloneDir, ".next", "server", "chunks"),
  )
  await copyDir(path.join(root, ".next", "static"), path.join(standaloneDir, ".next", "static"))
  await copyDir(path.join(root, "public"), path.join(standaloneDir, "public"))

  await copyDir(standaloneDir, targetServerDir)

  // 脚本与 integrations（与 Electron 链路一致）
  await fs.mkdir(path.join(targetServerDir, "scripts"), { recursive: true })
  for (const runner of [
    "codex-desktop-plugins-runner.cjs",
    "codex-desktop-model-whitelist-runner.cjs",
    "switchgate-web-search-mcp.cjs",
    "workbuddy-at-rest-key.ps1",
  ]) {
    await fs.copyFile(
      path.join(root, "scripts", runner),
      path.join(targetServerDir, "scripts", runner),
    )
  }
  await copyDir(
    path.join(root, "scripts", "web-search-mcp"),
    path.join(targetServerDir, "scripts", "web-search-mcp"),
  )
  if (await exists(path.join(root, "integrations", "codexbridge"))) {
    await copyDir(
      path.join(root, "integrations", "codexbridge"),
      path.join(targetServerDir, "integrations", "codexbridge"),
    )
  }

  // node_modules -> vendor，与 Electron 链路命名保持一致
  const nm = path.join(targetServerDir, "node_modules")
  const vendor = path.join(targetServerDir, "vendor")
  if (await exists(nm)) await fs.rename(nm, vendor)
  await pruneVendor(vendor)

  const maxLen = await assertNoLongPaths(targetServerDir)

  const size = await dirSize(targetServerDir)
  console.log(`Tauri 资源已就绪：tauri/src-tauri/resources/server`)
  console.log(`  体积 ${(size / 1024 / 1024).toFixed(0)}MB，最长路径 ${maxLen} 字符`)
}

async function dirSize(dir) {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(full)
    } else {
      try {
        total += (await fs.stat(full)).size
      } catch {
        // 忽略读不到的文件（断链、权限）
      }
    }
  }
  return total
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
