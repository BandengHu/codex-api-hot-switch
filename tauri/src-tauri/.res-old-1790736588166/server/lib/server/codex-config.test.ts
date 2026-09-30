import assert from "node:assert/strict"
import test from "node:test"

import { installConfigText } from "./codex-config"

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
