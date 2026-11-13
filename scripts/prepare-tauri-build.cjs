#!/usr/bin/env node
/**
 * 为 Tauri 外壳准备随包资源。
 *
 * Tauri 没有 asar 概念，resources 目录天然就是真实文件，因此这里只负责拷贝、
 * 裁剪运行时依赖并做完整性检查。发布包会携带 Node 运行时，vendor 通过 NODE_PATH 解析。
 */

const fs = require("node:fs/promises")
const path = require("node:path")
const {
  assertCodexBridgeStarts,
  copyDir,
  exists,
  pruneAllStaticToolBinaries,
  pruneNonRuntimeFiles,
  rmRetry,
} = require("./tauri-build-lib.cjs")
const { createCodexBridgeRuntimeCopier } = require("./tauri-codexbridge-runtime.cjs")
const {
  assertBundledNodeRuntime,
  assertNoLongPaths,
  assertResourcesComplete,
} = require("./tauri-resource-check.cjs")

const root = path.resolve(__dirname, "..")
const standaloneDir = path.join(root, ".next", "standalone")
const packageMode = process.argv[2] || "full"
// 允许用环境变量换个输出目录。
// 用途：万一 resources 目录被外部句柄占住（EPERM / ENOTEMPTY 清不掉），
// 可以直接指到新目录继续打包，不必先去跟残留文件较劲。
const tauriResourcesDir = process.env.TAURI_RESOURCES_DIR
  ? path.resolve(process.env.TAURI_RESOURCES_DIR)
  : path.join(root, "tauri", "src-tauri", "resources")
const targetServerDir = path.join(tauriResourcesDir, "server")

/**
 * `tsx` 的企业微信启动器走的是 `node --import <tsx>/dist/loader.mjs`。
 * `tsx` 本身只是薄壳，真正执行 TypeScript 的 `esbuild` 不在 Next standalone
 * 的追踪结果里，只存在于 pnpm 的 `.pnpm` 目录。这里显式给出当前平台包名，
 * 供依赖闭包与完整性检查共用。
 */
function esbuildPlatformPackageName() {
  return process.platform === "win32"
    ? (process.arch === "arm64" ? "@esbuild/win32-arm64" : "@esbuild/win32-x64")
    : process.platform === "darwin"
      ? (process.arch === "arm64" ? "@esbuild/darwin-arm64" : "@esbuild/darwin-x64")
      : process.arch === "arm64" ? "@esbuild/linux-arm64" : "@esbuild/linux-x64"
}

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)/u.exec(String(version || "").trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]) }
}

function assertSupportedBuildNode() {
  if (process.platform !== "win32") {
    throw new Error("Tauri NSIS 安装包必须使用 Windows 上的 Node 构建")
  }
  const parsed = parseNodeVersion(process.versions.node)
  if (!parsed || parsed.major < 22 || (parsed.major === 22 && parsed.minor < 5)) {
    throw new Error(
      `构建机 Node ${process.versions.node} 版本过低，需要 Node 22.5 或更高版本`,
    )
  }
}

async function copyBundledNodeRuntime(serverDir) {
  assertSupportedBuildNode()
  const source = await fs.realpath(process.execPath)
  const runtimeDir = path.join(serverDir, "runtime")
  const destination = path.join(runtimeDir, "node.exe")
  await fs.mkdir(runtimeDir, { recursive: true })
  await fs.copyFile(source, destination)

  let license = ""
  for (const name of ["LICENSE", "LICENSE.md"]) {
    const candidate = path.join(path.dirname(source), name)
    if (!(await exists(candidate))) continue
    await fs.copyFile(candidate, path.join(runtimeDir, name))
    license = path.join(runtimeDir, name)
    break
  }

  return {
    destination,
    license,
    source,
    version: process.versions.node,
  }
}

async function rewriteBundledBuildPaths(serverDir) {
  const files = [
    path.join(serverDir, "server.js"),
    path.join(serverDir, ".next", "required-server-files.json"),
  ]
  const buildRootForms = [root, root.replaceAll("\\", "/")]
  const rewritten = []

  for (const file of files) {
    if (!(await exists(file))) continue
    const before = await fs.readFile(file, "utf8")
    let after = before
    for (const form of buildRootForms) {
      after = after.split(JSON.stringify(form)).join(JSON.stringify("."))
    }
    if (after === before) continue
    await fs.writeFile(file, after, "utf8")
    rewritten.push(path.relative(serverDir, file))
  }

  for (const file of files) {
    if (!(await exists(file))) continue
    const contents = await fs.readFile(file, "utf8")
    for (const form of buildRootForms) {
      if (!contents.includes(JSON.stringify(form))) continue
      throw new Error(`随包资源仍包含构建机绝对路径：${path.relative(root, file)} -> ${form}`)
    }
  }

  return rewritten
}

const copyCodexBridgeRuntimeNodeModules = createCodexBridgeRuntimeCopier({
  root,
  exists,
  rmRetry,
  pruneAllStaticToolBinaries,
  pruneNonRuntimeFiles,
  platformPackageName: esbuildPlatformPackageName,
})

// 构建产物本身不能进包。
const tracedBuildArtifacts = [
  ".data",
  ".tmp",
  "dist",
  "tsconfig.tsbuildinfo",
  // Next 的 NFT 全项目追踪会把整个仓库根卷进 `.next/standalone`，
  // 其中就包含 `tauri/` —— 而 `tauri/src-tauri/resources/server/` 正是本次要写出的目录，
  // 于是形成自嵌套：资源树里出现 `resources/server/tauri/src-tauri/resources/server/...`，
  // 且 `dist/`（打包产物）被一起拖进来，资源从 33MB 涨到 8.6GB。
  // 之前 tsconfig 没排 `tauri` 时必现；现在排了也仍留着这道保险。
  "tauri",
]


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
 * 为什么可以删除：
 *
 * - **超长路径**。pnpm 的目录名把 peer 依赖校验和嵌了进去，例如
 *   `.pnpm/next@16.2.6_@babel+core@7.2_40a7effce8bcad24669d45809ebe449e/node_modules/@swc/helpers/...`。
 *   实测本包里有 **146 个条目**的绝对路径超过 Windows 的 260 字符上限（最长 291），
 *   NSIS 的 makensis 遇到就打不开文件并**整体中止**打包。
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

async function ensureTsxRuntimeDependencies(vendorNmDir) {
  const sourceStore = path.join(root, "node_modules", ".pnpm")
  if (!(await exists(sourceStore))) return []

  const platformPackage = esbuildPlatformPackageName()
  const wanted = ["esbuild", platformPackage]
  const missing = []

  for (const packageName of wanted) {
    const dest = path.join(vendorNmDir, ...packageName.split("/"))
    if (await exists(dest)) continue

    const encoded = packageName.startsWith("@")
      ? `@${packageName.slice(1).replace("/", "+")}@`
      : `${packageName}@`
    let source = ""
    for (const entry of await fs.readdir(sourceStore, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(encoded)) continue
      const candidate = path.join(sourceStore, entry.name, "node_modules", ...packageName.split("/"))
      if (await exists(candidate)) {
        source = candidate
        break
      }
    }
    if (!source) {
      missing.push(packageName)
      continue
    }

    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.cp(source, dest, {
      recursive: true,
      dereference: true,
      force: true,
      errorOnExist: false,
      maxRetries: 8,
      retryDelay: 150,
    })
  }

  if (missing.length > 0) {
    throw new Error(
      `缺少 tsx 运行时依赖：${missing.join("、")}。` +
        `请先在仓库根执行 pnpm install，再重新打包。`,
    )
  }
  return wanted
}

/**
 * 擦掉资源树里「自嵌套 / 混进构建产物」的目录。
 *
 * Next 的 NFT 在部分路由上会退化成「追踪整个项目根」，于是 `.next/standalone`
 * 里会带上一份仓库快照。拷贝到 `tauri/src-tauri/resources/server/` 之后，就出现
 * `resources/server/tauri/src-tauri/resources/server/...` 这种自嵌套，
 * 并且把 `dist/`（打包产物）一起拖进来 ——
 * 资源从 33MB 暴涨到 8.6GB，NSIS 打包会直接崩。
 *
 * 正常情形下 `main()` 已经用 `tracedBuildArtifacts` 在拷贝前清理过；
 * 这里只针对「已经落进目标目录」的残留做一次兜底，所以只扫顶层那几个已知名字。
 */
async function pruneSelfNestedDirs(serverDir) {
  const suspicious = [
    // 最坑的一个：资源树里套着 tauri/，而 tauri/src-tauri/resources/server 就是自己
    "tauri",
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

async function main() {
  if (!(await exists(path.join(standaloneDir, "server.js")))) {
    throw new Error("缺少 .next/standalone/server.js，请先运行 next build")
  }

  if (packageMode !== "full" && packageMode !== "remote-shell") {
    throw new Error(
      `打包模式只支持 full 或 remote-shell，收到：${packageMode}`,
    )
  }

  await rmRetry(tauriResourcesDir, { recursive: true, force: true })
  await fs.mkdir(tauriResourcesDir, { recursive: true })

  if (packageMode === "remote-shell") {
    await fs.copyFile(
      path.join(root, "scripts", "remote-shell.cjs"),
      path.join(standaloneDir, "server.js"),
    )
  } else {
    for (const artifact of tracedBuildArtifacts) {
      await rmRetry(path.join(standaloneDir, artifact), { recursive: true, force: true })
    }
    await copyDir(
      path.join(root, ".next", "server", "chunks"),
      path.join(standaloneDir, ".next", "server", "chunks"),
    )
    await copyDir(path.join(root, ".next", "static"), path.join(standaloneDir, ".next", "static"))
    await copyDir(path.join(root, "public"), path.join(standaloneDir, "public"))
    const flattened = await flattenPnpmStore(path.join(standaloneDir, "node_modules"))
    if (flattened.moved > 0) {
      console.log(`  源侧摊平 .pnpm：${flattened.moved} 个包移到顶层`)
    }
  }

  await copyDir(standaloneDir, targetServerDir)
  const bundledNodeRuntime = await copyBundledNodeRuntime(targetServerDir)

  if (packageMode === "remote-shell") {
    // 远程壳只部署 HTTP 反向代理，不携带供应商数据或完整 Next 运行时。
    await rmRetry(path.join(targetServerDir, ".next"), { recursive: true, force: true })
    await rmRetry(path.join(targetServerDir, "app"), { recursive: true, force: true })
    await rmRetry(path.join(targetServerDir, "components"), { recursive: true, force: true })
    await rmRetry(path.join(targetServerDir, "lib"), { recursive: true, force: true })
    await rmRetry(path.join(targetServerDir, "vendor"), { recursive: true, force: true })
  }

  // 补入运行时脚本与 integrations。
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
  let codexBridgeDependencies = []
  if (await exists(path.join(root, "integrations", "codexbridge"))) {
    const targetCodexBridgeDir = path.join(targetServerDir, "integrations", "codexbridge")
    await copyDir(
      path.join(root, "integrations", "codexbridge"),
      targetCodexBridgeDir,
    )
    codexBridgeDependencies = await copyCodexBridgeRuntimeNodeModules(targetCodexBridgeDir)
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
  await fs.mkdir(vendorNm, { recursive: true })
  const tsxRuntimePackages = await ensureTsxRuntimeDependencies(vendorNm)
  await pruneVendor(vendorNm)

  // 兜底：NFT 全项目追踪偶尔会把仓库根塞进 standalone，于是资源树里出现
  // `resources/server/tauri/`（自嵌套，还带着打包产物目录 `dist/`）。
  // 上面 `tracedBuildArtifacts` 已经尽量在拷贝前清理，这里再擦一次地。
  await pruneSelfNestedDirs(targetServerDir)
  const rewrittenPaths = await rewriteBundledBuildPaths(targetServerDir)

  const maxLen = await assertNoLongPaths(targetServerDir)
  const check = await assertResourcesComplete(
    targetServerDir,
    esbuildPlatformPackageName(),
    packageMode,
  )
  const bundledNode = await assertBundledNodeRuntime(targetServerDir)
  if (packageMode === "full") {
    assertCodexBridgeStarts(targetServerDir, bundledNode.path)
  }

  const size = await dirSize(targetServerDir)
  // 体积护栏：只抓「量级错」的情况（自嵌套会把资源撑到 GB 级）。
  //
  // 壳模式只携带反向代理与 Node 运行时，正常体积在 100MB 以内。
  // 这里仍然只拦量级异常，避免把正常差异当成打包失败。
  if (size > 1024 * 1024 * 1024) {
    throw new Error(
      `资源树异常膨胀：${(size / 1024 / 1024).toFixed(0)}MB（正常约 237MB）。\n` +
        `通常是有构建产物被 NFT 追踪卷了进来。请检查 ${targetServerDir} 下是否残留 ` +
        `tauri/ 、dist/ 等构建产物目录。`,
    )
  }
  console.log(`Tauri 资源已就绪：tauri/src-tauri/resources/server`)
  console.log(`  体积 ${(size / 1024 / 1024).toFixed(0)}MB，最长路径 ${maxLen} 字符`)
  console.log(
    packageMode === "full"
      ? `  关键路径自检通过（api 路由 ${check.apiRoutes} 项，chunks ${check.chunks} 项）`
      : `  关键路径自检通过（壳入口与随包 Node）`,
  )
  console.log(
    `  随包 Node ${bundledNodeRuntime.version}：${path.relative(root, bundledNodeRuntime.destination)}`,
  )
  if (rewrittenPaths.length > 0) {
    console.log(`  已清理构建机绝对路径：${rewrittenPaths.join("、")}`)
  }
  if (tsxRuntimePackages.length > 0) {
    console.log(`  tsx 运行时依赖已补齐：${tsxRuntimePackages.join("、")}`)
  }
  if (codexBridgeDependencies.length > 0) {
    console.log(`  CodexBridge 运行依赖已补齐：${codexBridgeDependencies.join("、")}`)
  }
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
