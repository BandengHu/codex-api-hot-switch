import "server-only"

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"

const DATA_DIR =
 process.env.CODEX_HOT_SWITCH_DATA_DIR ??
 path.join(process.env.APPDATA ?? process.cwd(), "codex-api-hot-switch", "data")

export async function appendTaskDebug(message: string) {
 try {
 await mkdir(DATA_DIR, { recursive: true })
 await appendFile(path.join(DATA_DIR, "task-debug.log"), `${message}\n`, "utf8")
 } catch {
 //调试日志不应影响主流程。
 }
}

