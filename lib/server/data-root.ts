import "server-only"

import { AsyncLocalStorage } from "node:async_hooks"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * 数据根目录的唯一解析点。
 *
 * 本机桌面/壳模式没有用户上下文，沿用 CODEX_HOT_SWITCH_DATA_DIR；
 * 服务器模式（CODEX_HOT_SWITCH_SERVER_UI=1）必须由鉴权层注入当前账号的
 * 数据目录，缺失时直接报错，绝不回退到根目录，否则会串到管理员数据。
 */

export const SHARED_DATA_DIR_ENV = "CODEX_HOT_SWITCH_DATA_DIR"

const accountStorage = new AsyncLocalStorage<string>()

export function isServerMode() {
  return process.env.CODEX_HOT_SWITCH_SERVER_UI === "1"
}

function defaultLocalDataDir() {
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "codex-api-hot-switch",
      "data",
    )
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "codex-api-hot-switch", "data")
  }
  return join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "codex-api-hot-switch",
    "data",
  )
}

/** 本机模式的数据根，同时用于服务器模式下账号目录的基准路径。 */
export function sharedDataDir() {
  return process.env[SHARED_DATA_DIR_ENV] || defaultLocalDataDir()
}

/** 在指定账号的数据目录内执行一段异步逻辑（一次请求的全部读写）。 */
export function runWithAccountDataDir<T>(dataDir: string, fn: () => T): T {
  return accountStorage.run(dataDir, fn)
}

export function accountDataDir(): string | null {
  return accountStorage.getStore() ?? null
}

/**
 * 当前上下文的数据目录。
 *
 * 定时器、后台任务等没有请求上下文的调用点，需要显式传入账号目录，
 * 否则在服务器模式下会抛出，防止把不同账号的数据写到一起。
 */
export function resolveDataDir() {
  const scoped = accountDataDir()
  if (scoped) return scoped
  if (isServerMode()) {
    throw new Error("服务器模式缺少账号上下文，拒绝使用共享数据目录")
  }
  return sharedDataDir()
}
