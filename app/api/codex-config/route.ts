import { NextResponse } from "next/server"
import { errorMessage, jsonError, readJsonBody } from "@/lib/server/http"
import {
  backupCurrentCodexConfig,
  codexHome,
  deleteCodexConfigBackupEntries,
  getCodexConfigStatus,
  installCodexConfig,
  installCodexWebSearchMcp,
  removeCodexWebSearchMcp,
  restoreCodexConfig,
  syncCodexModelCatalog,
  updateCodexConfigBackupEntryNote,
} from "@/lib/server/codex-config"
import { syncCodexSubagentRoles } from "@/lib/server/codex-subagent-roles"
import { getSnapshot, replaceSettings } from "@/lib/server/state-store"
import { CODEX_SUBAGENT_ROLE_COUNT } from "@/lib/codex-model-slug"

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

function subagentModelSlugs(value: unknown) {
  if (!Array.isArray(value) || value.length !== CODEX_SUBAGENT_ROLE_COUNT) {
    throw new Error(`子智能体模型必须配置 ${CODEX_SUBAGENT_ROLE_COUNT} 个槽位`)
  }
  return value.map((item, index) => requiredString(item, `子智能体 ${index + 1} 模型`))
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody<{
      action?: string
      note?: unknown
      backupId?: unknown
      backupIds?: unknown
      subagentModelSlugs?: unknown
    }>(request)
    const snapshot = await getSnapshot()
    if (body.action === "install") {
      return NextResponse.json(await installCodexConfig(snapshot.settings))
    }
    if (body.action === "sync-model-catalog") {
      await syncCodexModelCatalog(snapshot)
      await syncCodexSubagentRoles(codexHome(), snapshot)
      return NextResponse.json({
        status: await getCodexConfigStatus(snapshot.settings),
        message: "已同步 Codex 模型目录和子智能体角色，重启 Codex 桌面端后生效",
      })
    }
    if (body.action === "sync-subagent-roles") {
      const settings = {
        ...snapshot.settings,
        codexSubagentModelSlugs: subagentModelSlugs(body.subagentModelSlugs),
      }
      const updated = await replaceSettings(settings)
      await syncCodexModelCatalog(updated)
      await syncCodexSubagentRoles(codexHome(), updated)
      return NextResponse.json({
        status: await getCodexConfigStatus(updated.settings),
        message: "已保存并同步 4 个 Codex 子智能体角色，重启 Codex 桌面端后生效",
      })
    }
    if (body.action === "install-web-search-mcp") {
      return NextResponse.json(await installCodexWebSearchMcp(snapshot.settings))
    }
    if (body.action === "remove-web-search-mcp") {
      return NextResponse.json(await removeCodexWebSearchMcp(snapshot.settings))
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
