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
  "tsconfig.tsbuildinfo",
  // Next 的 NFT 全项目追踪会把整个仓库根卷进 `.next/standalone`，
  // 其中就包含 `tauri/` —— 而 `tauri/src-tauri/resources/server/` 正是本次要写出的目录，
  // 于是形成自嵌套：资源树里出现 `resources/server/tauri/src-tauri/resources/server/...`，
  // 且 `dist/`（Electron/Tauri 打包产物）被一起拖进来，资源从 33MB 涨到 8.6GB。
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

// ＮＯＴＥ：这里原本有个 `skipPnpmFilter`（拷贝时跳过 .pnpm），已删除。
// 那个策略是错的 —— standalone 顶层那 11 个包多是**符号链接**指向 `.pnpm`，
// 而 `next` 的传递依赖（`@swc/helpers` / `@next/env` / `styled-jsx` / `postcss` /
// `caniuse-lite` 等）**只存在于 `.pnpm` 里**。跳过后装到机器上就报：
//
//   Error: Cannot find module '@swc/helpers/_/_interop_require_default'
//   Require stack:
//   - .../vendor/next/dist/shared/lib/constants.js
//
// 正确做法见 flattenPnpmStore()：保留包内容、去掉带 peer 校验和的长目录名。

/**
 * 把 `.pnpm` 里的包**摊平**到 vendor 顶层，然后删掉 `.pnpm` 本身。
 *
 * 为什么必须这么做（两个约束卡在一起）：
 *
 * 1. **依赖必须在**。pnpm 布局下，`node_modules/.pnpm/<pkg>@<ver>_<hash>/node_modules/<pkg>`
 *    才是真实包体；顶层那 11 个多是符号链接。`next` 的传递依赖只在 `.pnpm` 里，
 *    删了 `.pnpm` 必然 `Cannot find module`（血泪验证过两次）。
 * 2. **长路径必须消**。`.pnpm` 目录名把 peer 校验和嵌了进去，例如
 *    `next@16.2.6_@babel+core@7.2_40a7effce8bcad24669d45809ebe449e`，实测 146 个条目
 *    绝对路径超 260 字符（最长 291），NSIS 的 makensis 直接中止打包。
 *
 * 摊平同时满足两者：把每个包按包名放到 **`<nmDir>/<name>`**
 * （作用域包放 `<nmDir>/@scope/name`），依赖解析退化成普通 node_modules 查找。
 *
 * ⚠️ **必须放在 `node_modules/` 这层，不能放 `<vendorDir>` 顶层**：
 * Node 解析 `next/dist/.../constants.js` 里的 `require('@swc/helpers/...')` 时，
 * 是从文件所在目录**逐级向上找名为 `node_modules` 的目录**：
 * `.../next/dist/shared/lib/node_modules` → `.../next/dist/node_modules` →
 * `.../next/node_modules` → `<vendorDir>/node_modules` ← 命中。
 * `<vendorDir>` 本身只对「顶层直接 require」有效（且要它在 NODE_PATH 里）。
 *
 * 注意再往上一层才是 `vendor` 与 standalone 的差异：
 * 传进来的 `nmDir` 在源侧是 `.next/standalone/node_modules`（含 `.pnpm`），
 * 在目标侧是 `<resources>/server/vendor`（Node 查找靠它下面的 `node_modules`）。
 *
 * 冲突处理：同名包多版本时**先到先得**并记录。实测本项目同名多版本只出现在
 * `openai` / `ws` / `zod-to-json-schema` 这类传递依赖上，与运行时主链无关。
 */
async function flattenPnpmStore(nmDir) {
  const store = path.join(nmDir, ".pnpm")
  if (!(await exists(store))) return { moved: 0, skipped: [] }

  const moved = []
  const conflicts = []

  for (const entry of await fs.readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // 每个 .pnpm 条目的真实包体在 <entry>/node_modules/ 下
    const innerNm = path.join(store, entry.name, "node_modules")
    if (!(await exists(innerNm))) continue

    for (const pkgEntry of await fs.readdir(innerNm, { withFileTypes: true })) {
      const from = path.join(innerNm, pkgEntry.name)

      // 作用域包：@scope/name
      if (pkgEntry.name.startsWith("@")) {
        let scopedChildren = []
        try {
          scopedChildren = await fs.readdir(from, { withFileTypes: true })
        } catch {
          continue
        }
        for (const child of scopedChildren) {
          if (!child.isDirectory()) continue
          const rel = path.join(pkgEntry.name, child.name)
          const dest = path.join(nmDir, rel)
          if (await exists(dest)) {
            conflicts.push(rel)
            continue
          }
          await fs.mkdir(path.dirname(dest), { recursive: true })
          await fs.rename(path.join(from, child.name), dest)
          moved.push(rel)
        }
        continue
      }

      if (!pkgEntry.isDirectory()) continue
      const dest = path.join(nmDir, pkgEntry.name)
      if (await exists(dest)) {
        conflicts.push(pkgEntry.name)
        continue
      }
      await fs.rename(from, dest)
      moved.push(pkgEntry.name)
    }
  }

  // 摊平完就没用了，而且它是超长路径的源头。
  await rmRetry(store, { recursive: true, force: true })

  return { moved: moved.length, skipped: [...new Set(conflicts)].sort() }
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
 * ⚠️ 这个函数**曾经是个 bug**，别再按「顶层包都是冗余」的思路去删。
 *
 * 历史教训：曾经认为「vendor 顶层包都是 .pnpm 里的重复拷贝，只留 tsx 就够」，
 * 于是把 `next` / `react` / `react-dom` / `zod` / `better-sqlite3` 等全删了。
 * 结果安装后 `node server.js` 直接崩：
 *
 *   Error: Cannot find module 'next'
 *   Require stack:
 *   - ...\resources\server\server.js
 *
 * 而外壳的探活只看「8787 能不能连上」，进程崩了它只会一直显示「正在启动…」，
 * 连报错都没有 —— 极难定位。
 *
 * **事实**：`.next/standalone/node_modules/` 下的那批包就是 Next standalone 的
 * 运行时依赖（实测 11 个：@openai / @wecom / better-sqlite3 / ffmpeg-static /
 * ffprobe-static / next / react / react-dom / tsx / ws / zod），
 * `server.js` 第 16 行 `require('next')` 就靠它们解析。
 * 而 `next` 自己的传递依赖（@swc/helpers 等）只存在于 `.pnpm` 里 ——
 * 所以 `.pnpm` **不能直接删**，必须先 `flattenPnpmStore()` 把包体摊平出来
 * （这一步在 `pruneVendor()` 最前面已经做了，此处拿到的已是摊平后的目录）。
 *
 * 所以这里只删 `dist` 这类**明确的构建产物**，运行时要什么就留什么。
 */
async function pruneVendorTopLevelBuildArtifacts(vendorDir) {
  if (!(await exists(vendorDir))) return
  // 仅这些是构建/缓存产物，不可能是运行时依赖
  const junk = new Set(["dist", ".cache"])
  for (const entry of await fs.readdir(vendorDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (!junk.has(entry.name.toLowerCase())) continue
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
 * 并且把 `dist/`（Electron/Tauri 打包产物）一起拖进来 ——
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
  // ⚠️ 顺序与「保留什么」都很关键：
  // 1. **先摊平 `.pnpm`**（把包按名并入同一层，再删 `.pnpm`）。
  //    源侧已经摊过一次，这里是对目标侧做兜底（幂等）。
  // 2. 只删构建产物（better-sqlite3 的编译中间件、静态工具二进制），
  //    **运行时包一个都不能删**（见 flattenPnpmStore 注释里的事故）。
  const flat = await flattenPnpmStore(vendorDir)
  if (flat.moved > 0) {
    console.log(`  已摊平 .pnpm：${flat.moved} 个包并入 vendor/node_modules/`)
  }
  if (flat.skipped.length > 0) {
    console.log(`  同名多版本保留先到的：${flat.skipped.join("、")}`)
  }

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
  await pruneVendorTopLevelBuildArtifacts(vendorDir)
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

/**
 * `server.js` 运行时会 `require()` 的顶层包，一个都不能少。
 *
 * 为什么单独列：体积护栏抓不到这类缺失 —— 删掉 `next`（161MB）只会让资源树
 * 「变小」，看起来更健康。但装到机器上就是 `Cannot find module 'next'`，
 * 而外壳只看 8787 通不通，表现为**无报错地一直显示「正在启动」**。
 *
 * 实测由 `.next/standalone/node_modules/` 决定（Next 的 outputFileTracing 产物），
 * 这里是它的快照。若某天 Next 版本变更导致依赖增减，以 standalone 那份为准。
 */
const REQUIRED_VENDOR_PACKAGES = [
  "next",
  "react",
  "react-dom",
  "zod",
  "ws",
  "@openai",
  "@wecom",
  "better-sqlite3",
  "tsx",
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

  // 运行时依赖：`vendor/node_modules/` 下必须有这些包，否则 node server.js 起来就崩。
  // 注意基准是 `vendor/node_modules`，不是 `vendor` —— 摊平后的包都在这层，
  // 而且 Node 的「逐级向上找 node_modules」也只会命中这一层。
  // （只检查存在性；实际可用性由「打包前实跑 server.js」兜底。）
  const missingVendor = []
  const vendorDir = path.join(dir, "vendor", "node_modules")
  for (const pkg of REQUIRED_VENDOR_PACKAGES) {
    let ok = false
    try {
      await fs.stat(path.join(vendorDir, pkg))
      ok = true
    } catch {
      ok = false
    }
    if (!ok) missingVendor.push(pkg)
  }

  const problems = [...missing.map((m) => `  缺失：${m}`)]
  if (apiCount < 5) problems.push(`  .next/server/app/api 下只有 ${apiCount} 项（预期 >= 5）`)
  if (chunks < 20) problems.push(`  .next/server/chunks 只有 ${chunks} 项（预期 >= 20）`)
  if (missingVendor.length > 0) {
    problems.push(
      `  vendor/node_modules 缺少运行时依赖：${missingVendor.join("、")}\n` +
        `    → server.js 会报「Cannot find module '...'」并崩溃，` +
        `而外壳只会一直显示「正在启动」。别删 vendor/node_modules 下的包！`,
    )
  }

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

  // 先在**源侧**把 `.pnpm` 摊平到顶层，再往目标拷（过滤掉已空的 `.pnpm`）。
  //
  // 为什么在源侧做：standalone 顶层那 11 个包多是**符号链接**指向 `.pnpm`，
  // 而 `copyDir` 用 `dereference: true` 会把它们解引用成实体副本 ——
  // 于是「顶层实体 + .pnpm 实体」两份并存，体积翻倍且解析路径仍可能踩坑。
  // 先摊平则：真实包体落到顶层，符号链接被 rename 上位替换，`.pnpm` 只剩空壳。
  //
  // ⚠️ 源侧改动会写进 `.next/standalone`（构建产物，重新 next build 会覆盖，可接受）。
  const flattened = await flattenPnpmStore(path.join(standaloneDir, "node_modules"))
  if (flattened.moved > 0) {
    console.log(`  源侧摊平 .pnpm：${flattened.moved} 个包移到顶层`)
  }
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

  // 顶层依赖目录保留 `vendor` 这个名字（既有约定，裁剪函数都基于它），
  // 但**必须叫 node_modules 的那一层要真的存在**：
  // `next` 内部 `require('@swc/helpers/...')` 是靠 Node「逐级向上找 node_modules」
  // 解析的，光把包放在 `vendor/` 顶层不生效。
  //
  // 所以最终结构是：`vendor/node_modules/<pkg>` —— vendor 是命名空间，
  // 真正被 Node 认的是里面的 node_modules。NODE_PATH 也相应指向 vendor/node_modules。
  const nm = path.join(targetServerDir, "node_modules")
  const vendor = path.join(targetServerDir, "vendor")
  const vendorNm = path.join(vendor, "node_modules")
  if (await exists(nm)) {
    await rmRetry(vendor)
    await fs.mkdir(vendor, { recursive: true })
    await fs.rename(nm, vendorNm)
  }
  await pruneVendor(vendorNm)

  // 兜底：NFT 全项目追踪偶尔会把仓库根塞进 standalone，于是资源树里出现
  // `resources/server/tauri/`（自嵌套，还带着打包产物目录 `dist/`）。
  // 上面 `tracedBuildArtifacts` 已经尽量在拷贝前清理，这里再擦一次地。
  await pruneSelfNestedDirs(targetServerDir)

  const maxLen = await assertNoLongPaths(targetServerDir)
  const check = await assertResourcesComplete(targetServerDir)

  const size = await dirSize(targetServerDir)
  // 体积护栏：只抓「量级错」的情况（自嵌套会把资源撑到 GB 级）。
  //
  // ⚠️ 参考值随 vendor 内容变化，别拿它当「越小越好」的指标：
  // - 正常值 **~237MB**，其中 vendor 约 192MB（next 161MB 是必须的，删了直接崩）；
  // - 曾经误把 vendor 顶层包删光，掉到 46MB，看起来"更健康"实则打出的包跑不起来。
  // 所以真正的正确性由 `assertResourcesComplete` 的 REQUIRED_VENDOR_PACKAGES 保证，
  // 这里只拦 1GB 以上的离谱膨胀。
  if (size > 1024 * 1024 * 1024) {
    throw new Error(
      `资源树异常膨胀：${(size / 1024 / 1024).toFixed(0)}MB（正常约 237MB）。\n` +
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
