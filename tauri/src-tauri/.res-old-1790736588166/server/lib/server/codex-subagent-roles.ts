import "server-only"

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  CODEX_AUTO_MODEL_SLUG,
  CODEX_SUBAGENT_ROLE_COUNT,
  defaultCodexSubagentModelSlugs,
} from "@/lib/codex-model-slug"
import { buildCodexClientModelsResponse } from "@/lib/server/codex-model-catalog"
import type { ConsoleSnapshot, Settings } from "@/lib/types"

const SUBAGENT_ROLE_PREFIX = "switchgate_agent_"

function rolesDirectoryPath(codexHome: string) {
  return join(codexHome, "agents")
}

function roleName(index: number) {
  return `${SUBAGENT_ROLE_PREFIX}${index + 1}`
}

function rolePath(codexHome: string, index: number) {
  return join(rolesDirectoryPath(codexHome), `${roleName(index)}.toml`)
}

function tomlString(value: string) {
  return JSON.stringify(value)
}

function roleConfigText(index: number, modelSlug: string) {
  const roleNumber = index + 1
  return [
    `name = ${tomlString(roleName(index))}`,
    `description = ${tomlString(`使用 SwitchGate 槽位 ${roleNumber} 配置的模型执行委派任务`)}`,
    `model = ${tomlString(modelSlug)}`,
    `developer_instructions = ${tomlString("执行父线程分配的任务，遵守当前工作区 AGENTS.md、权限边界和验收要求。")}`,
    "",
  ].join("\n")
}

async function readTextIfExists(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}

function topLevelString(text: string, key: string) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*("(?:\\\\.|[^"])*")\\s*$`, "m"))
  if (!match) return ""
  try {
    return JSON.parse(match[1]) as string
  } catch {
    return ""
  }
}

export async function syncCodexSubagentRoles(
  codexHome: string,
  snapshot: ConsoleSnapshot,
) {
  const availableModelSlugs = new Set(
    buildCodexClientModelsResponse(snapshot).models.map((model) => model.slug),
  )
  const configured = snapshot.settings.codexSubagentModelSlugs ?? defaultCodexSubagentModelSlugs()
  const selected = Array.from({ length: CODEX_SUBAGENT_ROLE_COUNT }, (_, index) => {
    const slug = configured[index]
    return availableModelSlugs.has(slug) ? slug : CODEX_AUTO_MODEL_SLUG
  })
  await mkdir(rolesDirectoryPath(codexHome), { recursive: true })
  await Promise.all(
    selected.map((modelSlug, index) =>
      writeFile(rolePath(codexHome, index), roleConfigText(index, modelSlug), "utf8"),
    ),
  )
  return selected
}

export async function removeCodexSubagentRoles(codexHome: string) {
  await Promise.all(
    Array.from({ length: CODEX_SUBAGENT_ROLE_COUNT }, (_, index) =>
      rm(rolePath(codexHome, index), { force: true }),
    ),
  )
}

export async function getCodexSubagentRolesStatus(
  codexHome: string,
  settings: Settings,
) {
  const expected = settings.codexSubagentModelSlugs ?? defaultCodexSubagentModelSlugs()
  const roles = await Promise.all(
    Array.from({ length: CODEX_SUBAGENT_ROLE_COUNT }, async (_, index) => {
      const path = rolePath(codexHome, index)
      const text = await readTextIfExists(path)
      const expectedModel = expected[index] || CODEX_AUTO_MODEL_SLUG
      const currentModel = topLevelString(text, "model")
      return {
        name: roleName(index),
        path,
        exists: Boolean(text),
        currentModel,
        expectedModel,
        synced: Boolean(text) && currentModel === expectedModel,
      }
    }),
  )
  return {
    directoryPath: rolesDirectoryPath(codexHome),
    synced: roles.every((role) => role.synced),
    roles,
  }
}
