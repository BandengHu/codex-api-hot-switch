import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
  backupCurrentCodexConfig,
  deleteCodexConfigBackupEntries,
  getCodexConfigStatus,
  installCodexConfig,
  restoreCodexConfig,
  syncCodexModelCatalog,
  updateCodexConfigBackupEntryNote,
} from "@/lib/server/codex-config"
import { getSnapshot } from "@/lib/server/state-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const snapshot = await getSnapshot()
    return NextResponse.json(await getCodexConfigStatus(snapshot.settings))
  } catch (error) {
    return jsonError(`读取 Codex 接入状态失败：${errorMessage(error)}`)
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : ""
}

function requiredString(value: unknown, label: string) {
  const text = stringValue(value).trim()
  if (!text) throw new Error(`${label}不能为空`)
  return text
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{ action?: string; note?: unknown; backupId?: unknown; backupIds?: unknown }>(request)
    const snapshot = await getSnapshot()
    if (body.action === "install") {
      return NextResponse.json(await installCodexConfig(snapshot.settings))
    }
    if (body.action === "sync-model-catalog") {
      await syncCodexModelCatalog(snapshot)
      return NextResponse.json({
        status: await getCodexConfigStatus(snapshot.settings),
        message: "已同步 Codex 模型目录，重启 Codex 桌面端后生效",
      })
    }
    if (body.action === "backup-current") {
      return NextResponse.json(await backupCurrentCodexConfig(snapshot.settings, stringValue(body.note)))
    }
    if (body.action === "restore") {
      return NextResponse.json(await restoreCodexConfig(snapshot.settings, stringValue(body.backupId)))
    }
    if (body.action === "delete-backups") {
      return NextResponse.json(await deleteCodexConfigBackupEntries(snapshot.settings, stringArray(body.backupIds)))
    }
    if (body.action === "update-backup-note") {
      return NextResponse.json(
        await updateCodexConfigBackupEntryNote(
          snapshot.settings,
          requiredString(body.backupId, "备份 ID"),
          stringValue(body.note),
        ),
      )
    }
    return jsonError("未知 Codex 配置动作", 400)
  } catch (error) {
    return jsonError(`修改 Codex 配置失败：${errorMessage(error)}`, 400)
  }
}
