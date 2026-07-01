import "server-only"

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { codexHome } from "./paths"

const DEFAULT_PROVIDER = "openai"

async function readTextIfExists(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}

function parseTomlQuotedString(raw: string) {
  const value = raw.trim()
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'")) return value.slice(1, -1)
  return value
}

export async function readCodexProviderInfo(home = codexHome()) {
  const text = await readTextIfExists(join(home, "config.toml"))
  const modelProviderMatch = text.match(
    /^model_provider\s*=\s*((?:"(?:\\.|[^"])*")|(?:'[^']*'))\s*$/m,
  )
  const currentProvider = modelProviderMatch
    ? parseTomlQuotedString(modelProviderMatch[1])
    : DEFAULT_PROVIDER
  const providers = new Set<string>()
  for (const match of text.matchAll(/^\[model_providers\.([^\]\s]+)\]\s*$/gm)) {
    providers.add(match[1].replace(/^["']|["']$/g, ""))
  }
  if (currentProvider) providers.add(currentProvider)
  return {
    currentProvider,
    currentProviderImplicit: !modelProviderMatch,
    configuredProviders: [...providers].sort((left, right) => left.localeCompare(right)),
  }
}
