"use strict"

const path = require("node:path")

const root = __dirname
const host = process.env.CODEX_HOT_SWITCH_HOST || "127.0.0.1"
const port = Number(process.env.CODEX_HOT_SWITCH_PORT || 54141)

process.env.NODE_ENV = "production"
process.env.HOSTNAME = host
process.env.PORT = String(port)

require(path.join(root, "server.js"))
