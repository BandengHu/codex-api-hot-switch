export const CODEGRAPH_MCP_SERVER_NAME = "codegraph"
export const CODEGRAPH_SECTION_START = "<!-- CODEGRAPH_START -->"
export const CODEGRAPH_SECTION_END = "<!-- CODEGRAPH_END -->"
export const CODEGRAPH_PACKAGE_NAME = "@colbymchenry/codegraph"

/** Official short marker-fenced instructions from CodeGraph installer. */
export const CODEGRAPH_INSTRUCTIONS_BLOCK = `${CODEGRAPH_SECTION_START}
## CodeGraph

In repositories indexed by CodeGraph (a \`.codegraph/\` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): \`codegraph_explore\` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): \`codegraph explore "<symbol names or question>"\` prints the same output.

If there is no \`.codegraph/\` directory, skip CodeGraph entirely — indexing is the user's decision.
${CODEGRAPH_SECTION_END}`

function tomlString(value: string) {
  return JSON.stringify(value)
}

function sectionBody(text: string, section: string) {
  const lines = text.split(/\r?\n/)
  const header = `[${section}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start < 0) return ""
  const body: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break
    body.push(lines[index])
  }
  return body.join("\n")
}

function sectionString(text: string, section: string, key: string) {
  const body = sectionBody(text, section)
  const match = body.match(new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, "m"))
  if (!match) return ""
  const raw = match[1].trim()
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string
    } catch {
      return raw.replace(/^"|"$/g, "")
    }
  }
  return raw
}

function sectionStringArray(text: string, section: string, key: string) {
  const body = sectionBody(text, section)
  const match = body.match(new RegExp(`^${key}\\s*=\\s*(\\[[^\\n]*\\])\\s*$`, "m"))
  if (!match) return [] as string[]
  try {
    const parsed = JSON.parse(match[1]) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

export function sectionBoolean(text: string, section: string, key: string) {
  const body = sectionBody(text, section)
  const match = body.match(new RegExp(`^${key}\\s*=\\s*(true|false)\\s*$`, "m"))
  return match ? match[1] === "true" : undefined
}

export function readSectionString(text: string, section: string, key: string) {
  return sectionString(text, section, key)
}

export function readSectionStringArray(text: string, section: string, key: string) {
  return sectionStringArray(text, section, key)
}

function removeSection(text: string, section: string) {
  const lines = text.split(/\r?\n/)
  const header = `[${section}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start < 0) return text
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index
      break
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n")
}

export function upsertCodegraphAgentsInstructions(current: string) {
  const start = current.indexOf(CODEGRAPH_SECTION_START)
  const end = current.indexOf(CODEGRAPH_SECTION_END)
  if (start >= 0 && end > start) {
    const before = current.slice(0, start).replace(/\s*$/, "\n\n")
    const after = current.slice(end + CODEGRAPH_SECTION_END.length).replace(/^\s*/, "\n")
    return `${before}${CODEGRAPH_INSTRUCTIONS_BLOCK}${after}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n"
  }
  const base = current.trimEnd()
  return `${base ? `${base}\n\n` : ""}${CODEGRAPH_INSTRUCTIONS_BLOCK}\n`
}

export function removeCodegraphAgentsInstructions(current: string) {
  const start = current.indexOf(CODEGRAPH_SECTION_START)
  const end = current.indexOf(CODEGRAPH_SECTION_END)
  if (start < 0 || end < start) return current
  const before = current.slice(0, start)
  const after = current.slice(end + CODEGRAPH_SECTION_END.length)
  const next = `${before}${after}`.replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "").trimEnd()
  return next ? `${next}\n` : ""
}

export function agentsInstructionsInstalled(text: string) {
  return (
    text.includes(CODEGRAPH_SECTION_START) &&
    text.includes(CODEGRAPH_SECTION_END) &&
    text.includes("codegraph_explore")
  )
}

export function codegraphMcpBlock(command: string) {
  return [
    `[mcp_servers.${CODEGRAPH_MCP_SERVER_NAME}]`,
    `command = ${tomlString(command)}`,
    `args = ${JSON.stringify(["serve", "--mcp"])}`,
    `startup_timeout_sec = 30`,
    `enabled = true`,
  ].join("\n")
}

export function removeCodegraphMcpConfigText(current: string) {
  return `${removeSection(current, `mcp_servers.${CODEGRAPH_MCP_SERVER_NAME}`).trimEnd()}\n`
}

export function installCodegraphMcpConfigText(current: string, command: string) {
  const next = removeCodegraphMcpConfigText(current).trimEnd()
  return `${next ? `${next}\n\n` : ""}${codegraphMcpBlock(command)}\n`
}

export function codegraphMcpConfigInstalled(text: string) {
  const section = `mcp_servers.${CODEGRAPH_MCP_SERVER_NAME}`
  const command = sectionString(text, section, "command")
  const args = sectionStringArray(text, section, "args")
  return Boolean(command) && args.includes("serve") && args.includes("--mcp")
}
