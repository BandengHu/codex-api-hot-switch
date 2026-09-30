"use strict"

/**
 * 为 Tauri 资源树补齐 CodexBridge 的生产依赖闭包。
 *
 * CodexBridge 不是 Next 的 bundle，而是由 tsx 在安装后的机器上直接运行
 * TypeScript 源码，因此它必须带自己的 node_modules。Next 的 NFT 只追踪
 * `/api/wecom-bridge` 运行时用到的子集，`qrcode`、`pngjs`、`dijkstrajs`
 * 这类传递依赖不会进 vendor，漏掉时企业微信服务会持续退出。
 */

const fs = require("node:fs/promises")
const path = require("node:path")

function createCodexBridgeRuntimeCopier({
  root,
  exists,
  rmRetry,
  pruneAllStaticToolBinaries,
  pruneNonRuntimeFiles,
  platformPackageName,
}) {
  async function copyPackageDir(from, to) {
    await rmRetry(to)
    await fs.cp(from, to, { recursive: true, dereference: true })
    const packageJsonPath = path.join(to, "package.json")
    if (!(await exists(packageJsonPath))) return
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"))
    if (packageJson.bundleDependencies || packageJson.bundledDependencies) return
    await rmRetry(path.join(to, "node_modules"))
  }

  function packageInstallPath(nodeModulesDir, packageName, ...parts) {
    return path.join(nodeModulesDir, ...packageName.split("/"), ...parts)
  }

  function shouldCopyOptionalPackage(packageName) {
    if (packageName.startsWith("@esbuild/")) return packageName === platformPackageName()
    return true
  }

  async function resolvePackageJsonFromNodeModules(packageName, searchPaths) {
    for (const searchPath of searchPaths) {
      let current = searchPath
      while (current !== path.dirname(current)) {
        if (path.basename(current) === "node_modules") {
          const candidate = packageInstallPath(current, packageName, "package.json")
          if (await exists(candidate)) return candidate
        }
        current = path.dirname(current)
      }
    }
    const rootCandidate = packageInstallPath(
      path.join(root, "node_modules"),
      packageName,
      "package.json",
    )
    return (await exists(rootCandidate)) ? rootCandidate : ""
  }

  async function resolvePackageJsonFromPnpmStore(packageName) {
    const pnpmDir = path.join(root, "node_modules", ".pnpm")
    if (!(await exists(pnpmDir))) return ""
    const prefix = `${packageName.replace("/", "+")}@`
    const entries = (await fs.readdir(pnpmDir))
      .filter((entry) => entry.startsWith(prefix))
      .sort()
    for (const entry of entries) {
      const candidate = packageInstallPath(
        path.join(pnpmDir, entry, "node_modules"),
        packageName,
        "package.json",
      )
      if (await exists(candidate)) return candidate
    }
    return ""
  }

  async function copyRuntimePackageClosure(
    packageName,
    targetNodeModules,
    seen,
    required,
    searchPaths,
  ) {
    if (seen.has(packageName)) return
    let packageJsonPath = ""
    let resolveError = null
    try {
      packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: searchPaths })
    } catch (error) {
      resolveError = error
      packageJsonPath = await resolvePackageJsonFromNodeModules(packageName, searchPaths)
      if (!packageJsonPath) packageJsonPath = await resolvePackageJsonFromPnpmStore(packageName)
    }
    if (!packageJsonPath) {
      if (!required) return
      throw new Error(
        `打包 CodexBridge 运行依赖失败，找不到 ${packageName}：` +
          (resolveError instanceof Error ? resolveError.message : String(resolveError ?? "")),
      )
    }

    seen.add(packageName)
    const packageDir = await fs.realpath(path.dirname(packageJsonPath))
    await copyPackageDir(packageDir, packageInstallPath(targetNodeModules, packageName))

    const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"))
    for (const dependency of Object.keys(packageJson.dependencies || {}).sort()) {
      await copyRuntimePackageClosure(dependency, targetNodeModules, seen, true, [
        packageDir,
        root,
      ])
    }
    const optionalDependencies = Object.keys(packageJson.optionalDependencies || {})
      .filter(shouldCopyOptionalPackage)
      .sort()
    for (const dependency of optionalDependencies) {
      await copyRuntimePackageClosure(dependency, targetNodeModules, seen, false, [
        packageDir,
        root,
      ])
    }
  }

  return async function copyCodexBridgeRuntimeNodeModules(codexBridgeDir) {
    const packageJsonPath = path.join(codexBridgeDir, "package.json")
    if (!(await exists(packageJsonPath))) return []
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"))
    const targetNodeModules = path.join(codexBridgeDir, "node_modules")
    await rmRetry(targetNodeModules)
    await fs.mkdir(targetNodeModules, { recursive: true })
    const seen = new Set()
    const dependencies = Object.keys(packageJson.dependencies || {}).sort()
    for (const dependency of dependencies) {
      await copyRuntimePackageClosure(dependency, targetNodeModules, seen, true, [
        codexBridgeDir,
        root,
      ])
    }
    await pruneAllStaticToolBinaries(targetNodeModules)
    await pruneNonRuntimeFiles(targetNodeModules)
    return dependencies
  }
}

module.exports = { createCodexBridgeRuntimeCopier }
