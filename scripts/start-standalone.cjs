const fs = require("node:fs")
const path = require("node:path")
const { resolveServerRuntimeConfig } = require("../electron/server-runtime-config.cjs")

const root = path.resolve(__dirname, "..")
const standaloneDir = path.join(root, ".next", "standalone")
const serverFile = path.join(standaloneDir, "server.js")

function copyDirSync(from, to) {
  fs.rmSync(to, { recursive: true, force: true })
  fs.cpSync(from, to, { recursive: true })
}

if (!fs.existsSync(serverFile)) {
  console.error("缺少 .next/standalone/server.js，请先运行 npm exec --yes pnpm@10.21.0 -- build")
  process.exit(1)
}

copyDirSync(path.join(root, ".next", "static"), path.join(standaloneDir, ".next", "static"))
copyDirSync(path.join(root, "public"), path.join(standaloneDir, "public"))
fs.mkdirSync(path.join(standaloneDir, "scripts"), { recursive: true })
for (const runner of [
  "codex-desktop-plugins-runner.cjs",
  "codex-desktop-model-whitelist-runner.cjs",
]) {
  fs.copyFileSync(
    path.join(root, "scripts", runner),
    path.join(standaloneDir, "scripts", runner),
  )
}
if (fs.existsSync(path.join(root, "integrations", "codexbridge"))) {
  copyDirSync(
    path.join(root, "integrations", "codexbridge"),
    path.join(standaloneDir, "integrations", "codexbridge"),
  )
}

const runtime = resolveServerRuntimeConfig({ root })
process.env.HOSTNAME = runtime.host
process.env.PORT = String(runtime.port)
process.env.CODEX_HOT_SWITCH_DATA_DIR = runtime.dataDir

require(serverFile)
