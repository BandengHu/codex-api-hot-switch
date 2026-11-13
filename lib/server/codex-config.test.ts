import assert from "node:assert/strict"
import test from "node:test"

import { installConfigText, installWebSearchMcpConfigText } from "./codex-config"
import type { Settings } from "@/lib/types"

test("重新注入时把旧 provider 名称固定改为 OpenAI", () => {
  const current = [
    'model_provider = "codex_local_access"',
    'model = "switchgate__auto"',
    "",
    "[model_providers.codex_local_access]",
    'name = "Codex API Service"',
    'base_url = "http://127.0.0.1:8787/v1"',
    'wire_api = "responses"',
    "",
  ].join("\n")

  const next = installConfigText(
    current,
    "http://127.0.0.1:8787/v1",
    "C:\\Users\\Administrator\\.codex\\codex-switchgate-model-catalog.json",
  )

  assert.match(
    next,
    /\[model_providers\.codex_local_access\]\s+name = "OpenAI"/u,
  )
  assert.doesNotMatch(next, /name = "Codex API Service"/u)
  assert.equal((next.match(/\[model_providers\.codex_local_access\]/gu) || []).length, 1)
})

test("Web Search MCP 默认使用 PATH 中的 node，避免锁定安装目录", () => {
  const previous = process.env.SWITCHGATE_MCP_NODE_PATH
  delete process.env.SWITCHGATE_MCP_NODE_PATH
  try {
    const next = installWebSearchMcpConfigText("", settings())
    assert.doesNotMatch(next, /^command\s*=/mu)
    assert.match(next, /^args = \["[^"]*switchgate-web-search-mcp\.cjs"\]$/mu)
    assert.doesNotMatch(next, /^NODE_PATH\s*=/mu)
  } finally {
    if (previous === undefined) delete process.env.SWITCHGATE_MCP_NODE_PATH
    else process.env.SWITCHGATE_MCP_NODE_PATH = previous
  }
})

test("Web Search MCP 可以显式配置固定 Node 路径", () => {
  const previous = process.env.SWITCHGATE_MCP_NODE_PATH
  process.env.SWITCHGATE_MCP_NODE_PATH = "C:\\Program Files\\nodejs\\node.exe"
  try {
    const next = installWebSearchMcpConfigText("", settings())
    assert.match(
      next,
      /^command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"$/mu,
    )
  } finally {
    if (previous === undefined) delete process.env.SWITCHGATE_MCP_NODE_PATH
    else process.env.SWITCHGATE_MCP_NODE_PATH = previous
  }
})

function settings(): Settings {
  return {
    port: 8787,
    listenAddress: "127.0.0.1",
  } as Settings
}
