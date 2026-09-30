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
// 允许用环境变量换个输出目录。
// 用途：万一 resources 目录被外部句柄占住（EPERM / ENOTEMPTY 清不掉），
// 可以直接指到新目录继续打包，不必先去跟残留文件较劲。
const tauriResourcesDir = process.env.TAURI_RESOURCES_DIR
  ? path.resolve(process.env.TAURI_RESOURCES_DIR)
  : path.join(root, "tauri", "src-tauri", "resources")
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
  // Next 的 NFT 全项目追踪会把整个仓库根卷进 `.next/standalone`，
  // 其中就包含 `tauri/` —— 而 `tauri/src-tauri/resources/server/` 正是本次要写出的目录，
  // 于是形成自嵌套：资源树里出现 `resources/server/tauri/src-tauri/resources/server/...`，
  // 且 `tauri/dist/`（Electron 免安装版，600MB+）被一起拖进来，资源从 33MB 涨到 8.6GB。
  // 之前 tsconfig 没排 `tauri` 时必现；现在排了也仍留着这道保险。
  "tauri",
]

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 带重试的删除。
 *
 * Windows 上删目录树经常遇到 `EPERM: operation not permitted, rmdir ...`：
 * 子项刚删完、父目录句柄还没释放（杀毒软件实时扫描、索引服务都会加剧），
 * 这时直接 rmdir 会被拒。Node 的 fs.rm 自带重试，但对这类瞬时占用仍可能失败，
 * 而一次失败就会让整个 23 分钟的资源准备白跑。这里显式重试并逐步加大间隔。
 */
async function rmRetry(target) {
  if (!(await exists(target))) return
  const delays = [0, 120, 300, 700, 1500]
  let lastError = null
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    try {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      return
    } catch (error) {
      lastError = error
      if (error && (error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EPERM" || error.code === "EBUSY")) {
        continue
      }
      throw error
    }
  }
  // 最后一次仍失败：如果目标已经不在，就当作成功（并发清理 / 已释放）
  if (!(await exists(target))) return
  throw lastError
}

/**
 * 拷贝目录树。
 *
 * `filter` 用来在拷贝阶段就剪掉整棵子树（比拷完再删快得多，也避开大量文件带来的瞬时错误）。
 * `maxRetries` 是必须的：Node 的 `fs.cp` 在多文件并发拷贝时，
 * 偶尔会因为 Windows 上的瞬时占用（杀软扫描、索引）报 ENOENT/EPERM，
 * 而源文件其实好端端地在原地 —— 实测遇到过
 * `ENOENT: copyfile '...\.next\standalone\node_modules\.pnpm\...\ZodError.cjs'`，
 * 同一文件单独 copyFile 完全成功。
 */
async function copyDir(from, to, filter) {
  await rmRetry(to)
  await fs.cp(from, to, {
    recursive: true,
    dereference: true,
    force: true,
    errorOnExist: false,
    maxRetries: 8,
    retryDelay: 150,
    ...(filter ? { filter } : {}),
  })
}

/// 拷贝 standalone 时跳过 `.pnpm`：反正最后要删（见 prunePnpmStore），
/// 提前剪掉能少拷几万个文件，既快又避开超长路径。
function skipPnpmFilter(src) {
  return !/[\\/]node_modules[\\/]\.pnpm([\\/]|$)/.test(src)
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
    await rmRetry(path.join(dir, entry.name), { recursive: true, force: true })
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
        await rmRetry(full, { recursive: true, force: true })
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
      await rmRetry(full, { recursive: true, force: true })
    }
  }
}

/**
 * vendor 顶层包多是 .pnpm 内容的重复拷贝；只保留 tsx
 * （企业微信启动器会读 `vendor/tsx/dist/loader.mjs` 作为 --import loader）。
 *
 * 注意：拷贝阶段已经用 `skipPnpmFilter` 把 .pnpm 剪掉了，所以这里不再以
 * 「.pnpm 是否存在」作为前置条件 —— 那会导致函数直接短路、顶层重复包不被清理。
 */
async function pruneDuplicatedTopLevelVendorPackages(vendorDir) {
  if (!(await exists(vendorDir))) return
  const keep = new Set([".pnpm", "tsx"])
  for (const entry of await fs.readdir(vendorDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (keep.has(entry.name.toLowerCase())) continue
    await rmRetry(path.join(vendorDir, entry.name), { recursive: true, force: true })
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
  await rmRetry(store, { recursive: true, force: true })
}

/**
 * 擦掉资源树里「自嵌套 / 混进构建产物」的目录。
 *
 * Next 的 NFT 在部分路由上会退化成「追踪整个项目根」，于是 `.next/standalone`
 * 里会带上一份仓库快照。拷贝到 `tauri/src-tauri/resources/server/` 之后，就出现
 * `resources/server/tauri/src-tauri/resources/server/...` 这种自嵌套，
 * 并且把 `tauri/dist/`（Electron 免安装版，600MB+）一起拖进来 ——
 * 资源从 33MB 暴涨到 8.6GB，NSIS 打包会直接崩。
 *
 * 正常情形下 `main()` 已经用 `tracedBuildArtifacts` 在拷贝前清理过；
 * 这里只针对「已经落进目标目录」的残留做一次兜底，所以只扫顶层那几个已知名字。
 */
async function pruneSelfNestedDirs(serverDir) {
  const suspicious = [
    // 最坑的一个：资源树里套着 tauri/，而 tauri/src-tauri/resources/server 就是自己
    "tauri",
    ".electron-shell",
    "dist",
    "win-unpacked",
    ".tmp",
    ".data",
  ]
  const removed = []
  for (const name of suspicious) {
    const full = path.join(serverDir, name)
    if (!(await exists(full))) continue
    await rmRetry(full, { recursive: true, force: true })
    removed.push(name)
  }
  if (removed.length > 0) {
    console.log(`  已清理误入资源树的构建产物：${removed.join("、")}`)
  }
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
    await rmRetry(path.join(vendorDir, ...rel), { recursive: true, force: true })
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

/**
 * 打包前的护栏：确认资源树里该有的东西都在。
 *
 * 起因是一次真实事故——脚本因为上级目录被句柄占住，`copyDir` 中途失败，
 * 但流程吞掉了错误继续跑完，最后打出一个只剩个别目录的包；装到机器上表现为
 * “找不到 server.js”，排查成本极高。与其信任“脚本退出码为 0”，
 * 不如在这里把运行时的关键路径逐个 stat 一遍，缺一个就立刻报错。
 */
const REQUIRED_RESOURCE_PATHS = [
  "server.js",
  "package.json",
  ".next/BUILD_ID",
  ".next/server",
  ".next/static",
]

async function assertResourcesComplete(dir) {
  const missing = []
  for (const rel of REQUIRED_RESOURCE_PATHS) {
    const full = path.join(dir, rel)
    let ok = false
    try {
      await fs.stat(full)
      ok = true
    } catch {
      ok = false
    }
    if (!ok) missing.push(rel)
  }

  // 路由目录至少要有若干个子项，空目录同样意味着打包不完整。
  const apiDir = path.join(dir, ".next", "server", "app", "api")
  let apiCount = 0
  try {
    apiCount = (await fs.readdir(apiDir)).length
  } catch {
    apiCount = 0
  }

  // chunks 数量太少同样意味着构建产物没拷全（正常约 190 项）。
  let chunks = 0
  try {
    chunks = (await fs.readdir(path.join(dir, ".next", "server", "chunks"))).length
  } catch {
    chunks = 0
  }

  const problems = [...missing.map((m) => `  缺失：${m}`)]
  if (apiCount < 5) problems.push(`  .next/server/app/api 下只有 ${apiCount} 项（预期 >= 5）`)
  if (chunks < 20) problems.push(`  .next/server/chunks 只有 ${chunks} 项（预期 >= 20）`)

  if (problems.length > 0) {
    throw new Error(
      `资源树不完整，打包会得到一个跑不起来的安装包：\n${problems.join("\n")}\n` +
        `目录：${dir}\n` +
        `常见原因：上一次构建残留 / 目录被句柄占用导致拷贝中断。` +
        `请删掉该目录后重新运行本脚本。`,
    )
  }
  return { apiRoutes: apiCount, chunks }
}

async function main() {
  if (!(await exists(path.join(standaloneDir, "server.js")))) {
    throw new Error("缺少 .next/standalone/server.js，请先运行 next build")
  }

  await rmRetry(tauriResourcesDir, { recursive: true, force: true })
  await fs.mkdir(tauriResourcesDir, { recursive: true })

  for (const artifact of tracedBuildArtifacts) {
    await rmRetry(path.join(standaloneDir, artifact), { recursive: true, force: true })
  }
  await copyDir(
    path.join(root, ".next", "server", "chunks"),
    path.join(standaloneDir, ".next", "server", "chunks"),
  )
  await copyDir(path.join(root, ".next", "static"), path.join(standaloneDir, ".next", "static"))
  await copyDir(path.join(root, "public"), path.join(standaloneDir, "public"))

  // 拷贝 standalone 时跳过 .pnpm（最终要删，提前剪掉可少拷几万文件）。
  // 其余三次拷贝目标都在 .next/ 下，不会碰到 .pnpm，不加过滤。
  await copyDir(standaloneDir, targetServerDir, skipPnpmFilter)

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

  // 兜底：NFT 全项目追踪偶尔会把仓库根塞进 standalone，于是资源树里出现
  // `resources/server/tauri/`（自嵌套，还带着 600MB 的 `tauri/dist`）。
  // 上面 `tracedBuildArtifacts` 已经尽量在拷贝前清理，这里再擦一次地。
  await pruneSelfNestedDirs(targetServerDir)

  const maxLen = await assertNoLongPaths(targetServerDir)
  const check = await assertResourcesComplete(targetServerDir)

  const size = await dirSize(targetServerDir)
  // 体积是「是否混进构建产物」的可靠信号：正常 ~33MB。超 120MB 必有问题，
  // 宁可报错让人查，也不要打出个 8GB 的安装包。
  if (size > 120 * 1024 * 1024) {
    throw new Error(
      `资源树异常膨胀：${(size / 1024 / 1024).toFixed(0)}MB（正常约 33MB）。\n` +
        `通常是有构建产物被 NFT 追踪卷了进来。请检查 ${targetServerDir} 下是否残留 ` +
        `tauri/ 、dist/ 、.electron-shell/ 等目录。`,
    )
  }
  console.log(`Tauri 资源已就绪：tauri/src-tauri/resources/server`)
  console.log(`  体积 ${(size / 1024 / 1024).toFixed(0)}MB，最长路径 ${maxLen} 字符`)
  console.log(`  关键路径自检通过（api 路由 ${check.apiRoutes} 项，chunks ${check.chunks} 项）`)
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
