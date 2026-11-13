import { execFileSync } from "node:child_process"
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const root = process.cwd()
// 默认使用独立目录，避免与本机开发/桌面的 .next 互相清理。
const distDirName = process.env.NEXT_DIST_DIR || ".next-server"
const nextDir = join(root, distDirName)
const standalone = join(nextDir, "standalone")
const outDir = join(root, "dist", "server")

/**
 * Next standalone 在 Windows 下用 junction 指回工作区 node_modules。
 * 构建产物必须完全自包含，否则复制到服务器后会指向不存在的路径。
 * 这里递归展开所有链接，展开完成后 `.pnpm` 不再被引用，可以删除。
 */
async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function materializeLinks(dir, relative = "") {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (relative === "" && entry.name === ".pnpm") continue
    const current = join(dir, entry.name)
    const currentRelative = relative ? `${relative}/${entry.name}` : entry.name
    const info = await lstat(current)
    if (info.isSymbolicLink()) {
      const source = join(root, "node_modules", currentRelative)
      if (!(await exists(source))) {
        throw new Error(`缺少依赖 ${currentRelative}，无法生成自包含服务器包`)
      }
      await rm(current, { recursive: true, force: true })
      await cp(source, current, { recursive: true, dereference: true })
      continue
    }
    if (info.isDirectory()) {
      await materializeLinks(current, currentRelative)
    }
  }
}

async function assertNoLinks(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const current = join(dir, entry.name)
    const info = await lstat(current)
    if (info.isSymbolicLink()) {
      throw new Error(`服务器包仍含链接：${current}`)
    }
    if (info.isDirectory()) {
      await assertNoLinks(current)
    }
  }
}

/**
 * Next standalone 在 Windows 上不会自动带入 `@next/env` 与 `@swc/helpers`，
 * 服务器启动会在 require `@swc/helpers/_/_interop_require_default` 时直接崩。
 * 这两个包必须从根 node_modules 显式补齐。
 */
const REQUIRED_PACKAGES = ["@next/env", "@swc/helpers"]

async function ensurePackages(nodeModules) {
  for (const name of REQUIRED_PACKAGES) {
    const target = join(nodeModules, name)
    if (await exists(target)) continue
    const source = await resolveInstalledPackage(name)
    if (!(await exists(source))) {
      throw new Error(`缺少依赖 ${name}，无法生成可启动的服务器包`)
    }
    await mkdir(join(target, ".."), { recursive: true })
    await cp(source, target, { recursive: true, dereference: true })
  }
}

/**
 * pnpm 的传递依赖只存在于 `.pnpm/<pkg>@<version>/node_modules/<pkg>`，
 * 根 `node_modules` 里没有顶层入口，必须按锁文件已安装的目录解析。
 */
async function resolveInstalledPackage(name) {
  const direct = join(root, "node_modules", name)
  if (await exists(direct)) return direct

  const encoded = name.replace("/", "+")
  const store = join(root, "node_modules", ".pnpm")
  const candidates = (await readdir(store))
    .filter((entry) => entry === encoded || entry.startsWith(`${encoded}@`))
    .sort()
  for (const entry of candidates) {
    const resolved = join(store, entry, "node_modules", name)
    if (await exists(resolved)) return resolved
  }
  return ""
}

function git(args) {
  // 用 execFileSync 避免 Windows 下 shell 引号与路径转义问题。
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

function readGitBuildInfo() {
  try {
    return {
      commit: git(["rev-parse", "HEAD"]),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: git(["status", "--porcelain"]).length > 0,
    }
  } catch {
    return { commit: "unknown", branch: "unknown", dirty: true }
  }
}

async function readNextBuildId() {
  const text = await readFile(join(nextDir, "BUILD_ID"), "utf8")
  return text.trim()
}

async function main() {
  if (process.argv.includes("--with-next")) {
    execFileSync("node", [join(root, "node_modules", "next", "dist", "bin", "next"), "build"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, NEXT_DIST_DIR: distDirName },
    })
  }

  if (!(await exists(join(standalone, "server.js")))) {
    throw new Error(`缺少 ${distDirName}/standalone/server.js，请先运行 npm run build`)
  }

  const nodeModules = join(standalone, "node_modules")
  await materializeLinks(nodeModules)
  // 所有链接已展开为实体，`.pnpm` 只是重复副本。
  await rm(join(nodeModules, ".pnpm"), { recursive: true, force: true })
  await ensurePackages(nodeModules)
  await assertNoLinks(nodeModules)

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  for (const name of ["server.js", "package.json", "node_modules", "public"]) {
    if (await exists(join(standalone, name))) {
      await cp(join(standalone, name), join(outDir, name), {
        recursive: true,
        dereference: true,
      })
    }
  }

  // standalone 不含 BUILD_ID、路由清单和客户端静态资源，
  // 必须从构建目录补入，否则服务端启动即报“找不到生产构建”。
  const skipAtRoot = new Set(["standalone", "cache", "dev", "trace", "trace-build"])
  await cp(nextDir, join(outDir, ".next"), {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const relative = source.slice(nextDir.length + 1)
      if (!relative) return true
      const [top] = relative.split(/[\\/]/)
      return !skipAtRoot.has(top)
    },
  })

  // standalone 的 server.js 内嵌了 distDir；部署包里统一用 `.next`，
  // 必须把这两个值同步改写，否则启动会去找不到不存在的目录。
  const serverPath = join(outDir, "server.js")
  const serverSource = await readFile(serverPath, "utf8")
  const rewritten = serverSource
    .replaceAll(`"./${distDirName}"`, '"./.next"')
    .replaceAll(`distDirRoot":"${distDirName}"`, 'distDirRoot":".next"')
  if (rewritten.includes(distDirName)) {
    throw new Error(`server.js 内仍残留构建目录 ${distDirName}`)
  }
  await writeFile(serverPath, rewritten, "utf8")

  const runnerDir = join(outDir, "scripts")
  await mkdir(runnerDir, { recursive: true })
  for (const runner of [
    "codex-desktop-plugins-runner.cjs",
    "codex-desktop-model-whitelist-runner.cjs",
    "switchgate-web-search-mcp.cjs",
  ]) {
    await cp(join(root, "scripts", runner), join(runnerDir, runner))
  }
  if (await exists(join(root, "scripts", "web-search-mcp"))) {
    await cp(
      join(root, "scripts", "web-search-mcp"),
      join(runnerDir, "web-search-mcp"),
      { recursive: true, dereference: true },
    )
  }
  if (await exists(join(root, "integrations", "codexbridge"))) {
    await cp(
      join(root, "integrations", "codexbridge"),
      join(outDir, "integrations", "codexbridge"),
      { recursive: true, dereference: true },
    )
  }

  for (const file of ["server-runtime-config.cjs", "start-standalone.cjs"]) {
    await cp(join(root, "scripts", file), join(outDir, file))
  }
  await cp(join(root, "deploy", "server", "start.cjs"), join(outDir, "start.cjs"))
  await cp(
    join(root, "deploy", "server", "tls-proxy.cjs"),
    join(outDir, "tls-proxy.cjs"),
  )

  const info = {
    ...readGitBuildInfo(),
    distDir: distDirName,
    nextBuildId: await readNextBuildId(),
    builtAt: new Date().toISOString(),
    node: process.version,
  }
  await writeFile(
    join(outDir, "BUILD_INFO.json"),
    `${JSON.stringify(info, null, 2)}\n`,
    "utf8",
  )

  console.log(`server bundle: ${outDir}`)
  console.log(
    `commit ${info.commit.slice(0, 12)} branch ${info.branch} next ${info.nextBuildId}`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})

