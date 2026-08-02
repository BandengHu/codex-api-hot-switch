import "server-only"

import { ProxyAgent } from "undici"
import { execFileSync } from "node:child_process"
import {
  parseBypassList,
  parseProxyServer,
  shouldBypassProxy,
  type SystemProxySettings,
} from "./system-proxy-settings"

const INTERNET_SETTINGS =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"

const CACHE_TTL_MS = 2000

let settingsCache: SystemProxySettings | null = null
let settingsCachedAt = 0
const agentByUrl = new Map<string, ProxyAgent>()

function queryRegValue(valueName: string): string | null {
  let out: string
  try {
    out = execFileSync(
      "reg",
      ["query", INTERNET_SETTINGS, "/v", valueName],
      { encoding: "utf8", windowsHide: true, timeout: 2000 },
    )
  } catch {
    return null
  }
  const typeMatch = out.match(/REG_(?:DWORD|SZ|EXPAND_SZ)\s+([^\r\n]*)/)
  if (!typeMatch) return null
  return typeMatch[1].trim()
}

function readSystemProxy(): SystemProxySettings {
  const enableRaw = queryRegValue("ProxyEnable")
  const serverRaw = queryRegValue("ProxyServer")
  const overrideRaw = queryRegValue("ProxyOverride")

  let enabled = false
  if (enableRaw !== null) {
    const hex = enableRaw.match(/^0x([0-9A-Fa-f]+)/)
    if (hex) enabled = parseInt(hex[1], 16) === 1
    else enabled = enableRaw === "1" || enableRaw.toLowerCase() === "true"
  }

  return {
    enabled,
    proxyUrl: enabled ? parseProxyServer(serverRaw) : null,
    bypassList: parseBypassList(overrideRaw),
  }
}

export function getSystemProxySettings(): SystemProxySettings {
  const now = Date.now()
  if (settingsCache && now - settingsCachedAt < CACHE_TTL_MS) {
    return settingsCache
  }
  settingsCache = readSystemProxy()
  settingsCachedAt = now
  return settingsCache
}

export function getSystemProxyDispatcher(
  targetUrl: string,
): ProxyAgent | undefined {
  const settings = getSystemProxySettings()
  if (!settings.enabled || !settings.proxyUrl) return undefined
  if (shouldBypassProxy(targetUrl, settings)) return undefined
  let agent = agentByUrl.get(settings.proxyUrl)
  if (!agent) {
    agent = new ProxyAgent(settings.proxyUrl)
    agentByUrl.set(settings.proxyUrl, agent)
  }
  return agent
}