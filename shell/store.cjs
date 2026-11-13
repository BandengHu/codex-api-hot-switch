"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { DATA_DIR } = require("./config.cjs")
const { createPasswordRecord, verifyPassword } = require("./auth.cjs")

const STORE_PATH = path.join(DATA_DIR, "shell-auth.json")
const VERSION = 1

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function write(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const temp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  fs.renameSync(temp, STORE_PATH)
  try {
    fs.chmodSync(STORE_PATH, 0o600)
  } catch {}
}

function setupRequired() {
  const current = read()
  return !current.password?.salt || !current.password?.hash || !current.sessionSecret
}

function configurePassword(password) {
  const next = {
    version: VERSION,
    password: createPasswordRecord(password),
    sessionSecret: crypto.randomBytes(32).toString("base64url"),
    updatedAt: new Date().toISOString(),
  }
  write(next)
  return next
}

function verifyLogin(password) {
  return verifyPassword(password, read().password)
}

function sessionSecret() {
  const current = read()
  if (!current.sessionSecret) throw new Error("壳尚未完成首次设置")
  return current.sessionSecret
}

module.exports = {
  STORE_PATH,
  configurePassword,
  sessionSecret,
  setupRequired,
  verifyLogin,
}
