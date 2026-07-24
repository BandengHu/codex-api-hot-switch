import assert from "node:assert/strict"
import test from "node:test"
import {
  CODEGRAPH_INSTRUCTIONS_BLOCK,
  CODEGRAPH_SECTION_END,
  CODEGRAPH_SECTION_START,
  agentsInstructionsInstalled,
  codegraphMcpBlock,
  codegraphMcpConfigInstalled,
  installCodegraphMcpConfigText,
  removeCodegraphAgentsInstructions,
  removeCodegraphMcpConfigText,
  upsertCodegraphAgentsInstructions,
} from "../codex-codegraph-text"

test("upsertCodegraphAgentsInstructions appends marker block once", () => {
  const first = upsertCodegraphAgentsInstructions("keep me\n")
  assert.match(first, /keep me/)
  assert.match(first, new RegExp(CODEGRAPH_SECTION_START))
  assert.match(first, /codegraph_explore/)
  assert.equal(agentsInstructionsInstalled(first), true)

  const second = upsertCodegraphAgentsInstructions(first)
  const starts = second.split(CODEGRAPH_SECTION_START).length - 1
  assert.equal(starts, 1)
  assert.match(second, /keep me/)
})

test("removeCodegraphAgentsInstructions strips only the marker block", () => {
  const withBlock = upsertCodegraphAgentsInstructions("alpha\n\nbeta\n")
  const removed = removeCodegraphAgentsInstructions(withBlock)
  assert.equal(removed.includes(CODEGRAPH_SECTION_START), false)
  assert.equal(removed.includes(CODEGRAPH_SECTION_END), false)
  assert.match(removed, /alpha/)
  assert.match(removed, /beta/)
})

test("install/remove codegraph MCP config preserves other sections", () => {
  const base = [
    'model = "switchgate__auto"',
    "",
    "[mcp_servers.switchgate_web_search]",
    'command = "node"',
    'args = ["scripts/switchgate-web-search-mcp.cjs"]',
    "enabled = true",
    "",
  ].join("\n")

  const installed = installCodegraphMcpConfigText(base, "codegraph")
  assert.equal(codegraphMcpConfigInstalled(installed), true)
  assert.match(installed, /mcp_servers\.switchgate_web_search/)
  assert.match(installed, /mcp_servers\.codegraph/)
  assert.equal(installed.includes(codegraphMcpBlock("codegraph").split("\n")[0]), true)

  const removed = removeCodegraphMcpConfigText(installed)
  assert.equal(codegraphMcpConfigInstalled(removed), false)
  assert.match(removed, /mcp_servers\.switchgate_web_search/)
  assert.equal(removed.includes("[mcp_servers.codegraph]"), false)
})

test("official instructions block stays short and conditional", () => {
  assert.match(CODEGRAPH_INSTRUCTIONS_BLOCK, /BEFORE grep\/find/)
  assert.match(CODEGRAPH_INSTRUCTIONS_BLOCK, /If there is no `\.codegraph\/` directory/)
  assert.ok(CODEGRAPH_INSTRUCTIONS_BLOCK.length < 1200)
})
