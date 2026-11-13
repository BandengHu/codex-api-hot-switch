"use strict"

/**
 * 服务器启动前的账号初始化。
 *
 * Next 的 standalone server 是 CommonJS 打包产物，TS 模块不能在这里直接 require，
 * 所以把「账号表格式」与「初始配置」都用 Node 原生方式实现一遍，
 * 保证引导逻辑不依赖应用运行时。
 */

const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/
const ADOPT_MARKER = ".adopted-into-account"
const STATE_VERSION = 3

function sharedDataDir() {
  if (process.env.CODEX_HOT_SWITCH_DATA_DIR) return process.env.CODEX_HOT_SWITCH_DATA_DIR
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Roaming"),
      "codex-api-hot-switch",
      "data",
    )
  }
  if (process.platform === "darwin") {
    return path.join(
      require("node:os").homedir(),
      "Library",
      "Application Support",
      "codex-api-hot-switch",
      "data",
    )
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(require("node:os").homedir(), ".local", "share"),
    "codex-api-hot-switch",
    "data",
  )
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode })
  fs.renameSync(temp, file)
}

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex")
}

function accountDataDir(shared, id) {
  return path.join(shared, "accounts", id)
}

function ensureAuthFile(dataDir) {
  const file = path.join(dataDir, "access-auth.json")
  if (fs.existsSync(file)) return null
  const apiKey = `sg_${crypto.randomBytes(24).toString("base64url")}`
  const salt = crypto.randomBytes(16).toString("hex")
  const now = new Date().toISOString()
  writeJson(file, {
    version: 1,
    keySalt: salt,
    keyHash: hash(apiKey, salt),
    sessionSecret: crypto.randomBytes(32).toString("base64url"),
    createdAt: now,
    updatedAt: now,
  })
  return apiKey
}

/**
 * 空白配置：只写最小可用的结构，让页面能打开并引导用户自己添加供应商。
 * 供应商为空是刻意的——新账号不应继承任何人的上游 Key。
 */
function writeBlankState(dataDir) {
  const file = path.join(dataDir, "hot-switch-state.json")
  if (fs.existsSync(file)) return
  writeJson(
    file,
    {
      version: STATE_VERSION,
      providers: [],
      models: [],
      mappings: [],
      runtime: {
        activeProviderId: "",
        activeModelId: "",
        reasoning: "auto",
        takeover: "paused",
      },
      settings: {
        listenAddress: "127.0.0.1",
        port: 8787,
        takeoverEnabled: false,
        defaultProviderId: "",
        defaultModelId: "",
        defaultReasoning: "auto",
        auxiliaryRoutingEnabled: false,
        auxiliaryProviderId: "",
        auxiliaryModelId: "",
        auxiliaryReasoning: "auto",
        codexSubagentModelSlugs: [],
        imageGenerationProviderId: "",
        imageGenerationModelId: "",
        logRetentionDays: 3,
        fullRequestLoggingEnabled: false,
        webSearchMode: "disabled",
        alphaSearchMode: "auto",
        keyStorage: "local",
        tokenStatsResetAt: new Date().toISOString(),
      },
    },
    0o600,
  )
}

function adoptExisting(shared, dataDir) {
  const marker = path.join(shared, ADOPT_MARKER)
  if (fs.existsSync(marker)) return false
  const sourceState = path.join(shared, "hot-switch-state.json")
  if (!fs.existsSync(sourceState)) return false
  if (fs.existsSync(path.join(dataDir, "hot-switch-state.json"))) return false

  fs.mkdirSync(dataDir, { recursive: true })
  const movable = [
    "hot-switch-state.json",
    "access-auth.json",
    "provider-endpoint-runtime.json",
    "wecom-bridge-settings.json",
    "workbuddy-at-rest-key.json",
    "task-debug.log",
    "telemetry",
    "logs",
    "workbuddy-pool",
    "workbuddy-global-pool",
  ]
  for (const name of movable) {
    const from = path.join(shared, name)
    if (!fs.existsSync(from)) continue
    fs.renameSync(from, path.join(dataDir, name))
  }
  fs.writeFileSync(marker, new Date().toISOString(), "utf8")
  return true
}

function bootstrap() {
  if (process.env.CODEX_HOT_SWITCH_SERVER_UI !== "1") return
  const username = String(process.env.SWITCHGATE_ADMIN_USERNAME || "").trim().toLowerCase()
  if (!username) return
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error("SWITCHGATE_ADMIN_USERNAME 格式不正确")
  }

  const shared = sharedDataDir()
  const accountsFile = path.join(shared, "accounts.json")
  const parsed = readJson(accountsFile) || { version: 1, accounts: [] }
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
  const existing = accounts.find((account) => account.username === username)

  if (existing) {
    const dataDir = accountDataDir(shared, existing.id)
    fs.mkdirSync(dataDir, { recursive: true })
    ensureAuthFile(dataDir)
    return
  }

  const password = process.env.SWITCHGATE_ADMIN_PASSWORD || ""
  if (password.length < 8) {
    throw new Error(
      `管理员 ${username} 不存在，且未提供有效的 SWITCHGATE_ADMIN_PASSWORD`,
    )
  }

  const id = crypto.randomUUID()
  const salt = crypto.randomBytes(16).toString("hex")
  const now = new Date().toISOString()
  const account = {
    id,
    username,
    role: "admin",
    status: "active",
    passwordSalt: salt,
    passwordHash: hash(password, salt),
    createdAt: now,
    updatedAt: now,
    approvedAt: now,
  }
  writeJson(accountsFile, { version: 1, accounts: [...accounts, account] })

  const dataDir = accountDataDir(shared, id)
  fs.mkdirSync(dataDir, { recursive: true })
  const adopted =
    process.env.SWITCHGATE_ADOPT_EXISTING === "1" ? adoptExisting(shared, dataDir) : false
  if (!adopted) writeBlankState(dataDir)
  ensureAuthFile(dataDir)

  console.log(`account bootstrap: ${username} (${adopted ? "adopted existing data" : "blank"})`)
}

bootstrap()
