import "server-only"

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { resolveDataDir } from "@/lib/server/data-root"

export async function appendTaskDebug(message: string) {
 try {
 const dataDir = resolveDataDir()
 await mkdir(dataDir, { recursive: true })
 await appendFile(path.join(dataDir, "task-debug.log"), `${message}\n`, "utf8")
 } catch {
 //调试日志不应影响主流程。
 }
}

