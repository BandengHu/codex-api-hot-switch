export interface SystemProxySettings {
  enabled: boolean
  proxyUrl: string | null
  bypassList: string[]
}

export function parseProxyServer(raw: string | null): string | null {
  if (!raw) return null
  const s = raw.trim()
  if (!s) return null
  let addr = s
  for (const part of s.split(";").map((p) => p.trim())) {
    if (!part) continue
    const m = part.match(/^([A-Za-z][A-Za-z0-9+.-]*)\s*=\s*(.+)$/)
    if (m && m[1].toLowerCase() === "https") {
      addr = m[2].trim()
      break
    }
  }
  if (!addr) return null
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(addr)) addr = `http://${addr}`
  try {
    new URL(addr)
  } catch {
    return null
  }
  return addr
}

export function parseBypassList(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !/^<.*>$/.test(s))
}

export function shouldBypassProxy(
  targetUrl: string,
  settings: SystemProxySettings,
): boolean {
  if (!settings.bypassList.length) return false
  let host: string
  try {
    host = new URL(targetUrl).hostname.toLowerCase()
  } catch {
    return true
  }
  return settings.bypassList.some((entry) => {
    let p = entry.toLowerCase().replace(/^\./, "").replace(/^\*+\./, "")
    if (!p) return false
    if (entry.startsWith("*.")) {
      return host.endsWith(p) || host === p
    }
    return host === p || host.endsWith(`.${p}`)
  })
}