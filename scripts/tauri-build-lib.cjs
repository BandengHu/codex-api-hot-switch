"use strict"

/**
 * Tauri 资源准备的共享工具。
 *
 * 这里只放与目录复制、Windows 瞬时占用、pnpm vendor 裁剪相关的通用逻辑，
 * 避免主脚本和 CodexBridge 运行依赖模块各维护一套实现。
 */

const fs = require("node:fs/promises")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { pathToFileURL } = require("node:url")

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
 * 而一次失败就会让整个资源准备白跑。这里显式重试并逐步加大间隔。
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
      if (
        error &&
        (error.code === "ENOENT" ||
          error.code === "ENOTEMPTY" ||
          error.code === "EPERM" ||
          error.code === "EBUSY")
      ) {
        continue
      }
      throw error
    }
  }
  if (!(await exists(target))) return
  throw lastError
}

/**
 * 拷贝目录树。
 *
 * `maxRetries` 是必须的：Node 的 fs.cp 在多文件并发拷贝时偶尔会因为 Windows
 * 上的瞬时占用（杀软扫描、索引）报 ENOENT/EPERM，而源文件其实好端端在原地。
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
  const keep = new Set(keepNames.map((name) => name.toLowerCase()))
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (keep.has(entry.name.toLowerCase())) continue
    await rmRetry(path.join(dir, entry.name))
  }
}

async function pruneStaticToolBinaries(dir) {
  if (!(await exists(dir))) return
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const hasWin32 = entries.some(
    (entry) => entry.isDirectory() && entry.name.toLowerCase() === "win32",
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
        ["test", "tests", "__tests__", "example", "examples", "benchmark", "benchmarks", "docs"].includes(
          lower,
        )
      ) {
        await rmRetry(full)
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
      await rmRetry(full)
    }
  }
}

/**
 * 用与生产启动器相同的 loader + cli.ts + NODE_PATH 组合真实跑一次
 * CodexBridge CLI。仅检查文件存在不够：包体在、传递依赖缺失时，
 * Web 服务正常但企业微信服务会在启动后立即退出。
 *
 * CLI 的 `--help` 自身以退出码 1 结束，因此要允许 1，同时确认 stderr
 * 没有未捕获异常或模块解析错误。
 */
function assertCodexBridgeStarts(serverDir) {
  const loader = path.join(serverDir, "vendor", "node_modules", "tsx", "dist", "loader.mjs")
  const cli = path.join(serverDir, "integrations", "codexbridge", "src", "cli.ts")
  if (!require("node:fs").existsSync(loader) || !require("node:fs").existsSync(cli)) {
    throw new Error("CodexBridge 启动自检失败：缺少 tsx loader 或 cli.ts")
  }

  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(loader).href, cli, "--help"],
    {
      cwd: path.join(serverDir, "integrations", "codexbridge"),
      env: {
        ...process.env,
        NODE_PATH: path.join(serverDir, "vendor", "node_modules"),
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  )

  if (result.error) throw result.error
  const stderr = String(result.stderr || "")
  if (/(?:Error|ERR_MODULE_NOT_FOUND|Cannot find (?:package|module))/u.test(stderr)) {
    throw new Error(`CodexBridge 启动自检失败：\n${stderr.trim()}`)
  }
  if (result.status !== 0 && result.status !== 1) {
    const detail = [result.stdout, stderr].filter(Boolean).join("\n").trim()
    throw new Error(`CodexBridge 启动自检失败（退出码 ${result.status}）：\n${detail}`)
  }
}

module.exports = {
  assertCodexBridgeStarts,
  copyDir,
  exists,
  pruneAllStaticToolBinaries,
  pruneNonRuntimeFiles,
  rmRetry,
}
