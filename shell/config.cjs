"use strict"

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const DEFAULT_REMOTE_BASE = "http://switch.ztsnss.cloud:54140"

function shellDataDir() {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "codex-switchgate-shell",
    )
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "codex-switchgate-shell")
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "codex-switchgate-shell",
  )
}

const DATA_DIR = process.env.SWITCHGATE_SHELL_DATA_DIR || shellDataDir()
const CONFIG_PATH = path.join(DATA_DIR, "shell.json")

function readStored() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function normalizeRemoteBase(value) {
  const raw = String(value || "").trim() || DEFAULT_REMOTE_BASE
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("服务器地址必须是 http 或 https")
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

function remoteBase() {
  return normalizeRemoteBase(process.env.SWITCHGATE_REMOTE_BASE || readStored().remoteBase)
}

function readServerKey() {
  return String(readStored().serverKey || "")
}

function writeConfig(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const temp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temp, CONFIG_PATH)
  try {
    fs.chmodSync(CONFIG_PATH, 0o600)
  } catch {}
}

function saveServerKey(serverKey) {
  const current = readStored()
  writeConfig({ ...current, serverKey, updatedAt: new Date().toISOString() })
}

function saveRemoteBase(value) {
  const current = readStored()
  writeConfig({ ...current, remoteBase: normalizeRemoteBase(value) })
}

function clearServerKey() {
  const current = readStored()
  const { serverKey: _removed, ...rest } = current
  writeConfig(rest)
}

module.exports = {
  CONFIG_PATH,
  DATA_DIR,
  DEFAULT_REMOTE_BASE,
  clearServerKey,
  normalizeRemoteBase,
  readServerKey,
  remoteBase,
  saveRemoteBase,
  saveServerKey,
}
