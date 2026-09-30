"use strict"

/**
 * Tauri 资源树的完整性与路径长度检查。
 *
 * NSIS 打不开超过 Windows 260 字符上限的文件；资源拷贝中断也可能留下
 * “看起来能打包、装上去却跑不起来”的空壳。这里在 makensis 之前把两类问题
 * 都拦下来，并给出可操作的具体路径。
 */

const fs = require("node:fs/promises")
const path = require("node:path")

const REQUIRED_RESOURCE_PATHS = [
  "server.js",
  "package.json",
  ".next/BUILD_ID",
  ".next/server",
  ".next/static",
]

function requiredVendorPackages(platformPackageName) {
  return [
    "next",
    "react",
    "react-dom",
    "zod",
    "ws",
    "@openai",
    "@wecom",
    "better-sqlite3",
    "tsx",
    "esbuild",
    platformPackageName,
  ]
}

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
        offenders.map((item) => `  ${item}`).join("\n"),
    )
  }
  return maxLen
}

async function assertResourcesComplete(dir, platformPackageName) {
  const missing = []
  for (const rel of REQUIRED_RESOURCE_PATHS) {
    try {
      await fs.stat(path.join(dir, rel))
    } catch {
      missing.push(rel)
    }
  }

  const apiDir = path.join(dir, ".next", "server", "app", "api")
  let apiCount = 0
  try {
    apiCount = (await fs.readdir(apiDir)).length
  } catch {
    apiCount = 0
  }

  let chunks = 0
  try {
    chunks = (await fs.readdir(path.join(dir, ".next", "server", "chunks"))).length
  } catch {
    chunks = 0
  }

  const missingVendor = []
  const vendorDir = path.join(dir, "vendor", "node_modules")
  for (const pkg of requiredVendorPackages(platformPackageName)) {
    try {
      await fs.stat(path.join(vendorDir, pkg))
    } catch {
      missingVendor.push(pkg)
    }
  }

  const problems = [...missing.map((item) => `  缺失：${item}`)]
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

module.exports = {
  assertNoLongPaths,
  assertResourcesComplete,
  requiredVendorPackages,
}
