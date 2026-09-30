const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const APP_STORAGE_NAME = "codex-api-hot-switch"
const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 8787

function defaultDataDir(root = process.cwd()) {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(process.env.USERPROFILE || root, "AppData", "Roaming"),
      APP_STORAGE_NAME,
      "data",
    )
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_STORAGE_NAME, "data")
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    APP_STORAGE_NAME,
    "data",
  )
}

function readJson(pathname) {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"))
  } catch {
    return null
  }
}

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

function isLoopbackHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    /^127\./.test(host)
  )
}

function resolveHost(value) {
  const host = String(value || "").trim() || DEFAULT_HOST
  if (isLoopbackHost(host)) return host
  if (process.env.CODEX_HOT_SWITCH_ALLOW_LAN === "1") return host
  return DEFAULT_HOST
}

function loadSavedSettings(dataDir) {
  const state = readJson(path.join(dataDir, "hot-switch-state.json"))
  return state && typeof state === "object" && state.settings ? state.settings : {}
}

function resolveServerRuntimeConfig(options = {}) {
  const dataDir = process.env.CODEX_HOT_SWITCH_DATA_DIR || defaultDataDir(options.root)
  const settings = loadSavedSettings(dataDir)
  const port =
    validPort(process.env.CODEX_HOT_SWITCH_PORT) ||
    validPort(settings.port) ||
    DEFAULT_PORT
  const host = resolveHost(process.env.CODEX_HOT_SWITCH_HOST || settings.listenAddress)

  return {
    dataDir,
    host,
    port,
    appUrl: `http://${host === "0.0.0.0" ? DEFAULT_HOST : host}:${port}`,
  }
}

module.exports = {
  APP_STORAGE_NAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultDataDir,
  resolveServerRuntimeConfig,
}
