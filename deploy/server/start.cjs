"use strict"

const path = require("node:path")

const root = __dirname
const host = process.env.CODEX_HOT_SWITCH_HOST || "127.0.0.1"
const port = Number(process.env.CODEX_HOT_SWITCH_PORT || 54141)

process.env.NODE_ENV = "production"
process.env.HOSTNAME = host
process.env.PORT = String(port)

// 服务器首次启动时创建管理员账号，并可按需把现有配置迁入该账号。
require(path.join(root, "scripts", "bootstrap-accounts.cjs"))

require(path.join(root, "server.js"))
