const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

process.env.CODEX_HOME = "C:\\SwitchGateTest\\.codex"

const {
  cacheLatestStatus,
  compareVersionStringsDescending,
  isManagedMarketplaceSource,
  pathIsWithin,
  parseVersionFromInstallPath,
  repairPluginLatest,
  samePath,
  updatedPluginConfig,
} = require("./codex-desktop-plugins-runner.cjs")

const managedSource =
  `\\\\?\\${path.join(process.env.CODEX_HOME, ".tmp", "bundled-marketplaces", "openai-bundled")}`

test("Codex managed bundled marketplace is not treated as a manual source", () => {
  assert.equal(isManagedMarketplaceSource(managedSource), true)
  assert.equal(
    isManagedMarketplaceSource(
      path.join(process.env.CODEX_HOME, "plugins", "marketplace-source", "openai-bundled"),
    ),
    false,
  )
})

test("managed marketplace path comparison accepts Windows extended paths", () => {
  assert.equal(
    samePath(
      managedSource,
      path.join(process.env.CODEX_HOME, ".tmp", "bundled-marketplaces", "openai-bundled"),
    ),
    true,
  )
})

test("legacy cache targets are detected without matching sibling paths", () => {
  const legacyRoot = path.join(
    process.env.CODEX_HOME,
    "plugins",
    "marketplace-source",
    "openai-bundled",
  )
  assert.equal(pathIsWithin(path.join(legacyRoot, "plugins", "browser"), legacyRoot), true)
  assert.equal(pathIsWithin(`${legacyRoot}-backup\\plugins\\browser`, legacyRoot), false)
})

test("plugin config preserves Codex managed source and enables bundled plugins", () => {
  const next = updatedPluginConfig(`
[marketplaces.openai-bundled]
source_type = "local"
source = '${managedSource}'
`)
  assert.match(next, /\[marketplaces\.openai-bundled\]/)
  assert.match(next, /\[plugins\."browser@openai-bundled"\][\s\S]*enabled = true/)
  assert.match(next, /\[plugins\."chrome@openai-bundled"\][\s\S]*enabled = true/)
  assert.match(next, /\[plugins\."computer-use@openai-bundled"\][\s\S]*enabled = true/)
})

test("plugin config removes the legacy manual bundled source", () => {
  const next = updatedPluginConfig(`
[marketplaces.openai-bundled]
source_type = "local"
source = '${path.join(process.env.CODEX_HOME, "plugins", "marketplace-source", "openai-bundled")}'

[models]
enabled = true
`)
  assert.doesNotMatch(next, /\[marketplaces\.openai-bundled\]/)
  assert.match(next, /\[models\]/)
})

test("plugin install versions are compared numerically", () => {
  assert.equal(compareVersionStringsDescending("26.730.7989.0", "26.727.6591.0"), -3)
  assert.equal(
    parseVersionFromInstallPath(
      "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.730.7989.0_x64__family",
    ),
    "26.730.7989.0",
  )
})

test("dangling latest junctions are detected as existing but invalid", async () => {
  const previousHome = process.env.CODEX_HOME
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "switchgate-plugin-cache-"))
  process.env.CODEX_HOME = testHome
  try {
    const latest = path.join(
      testHome,
      "plugins",
      "cache",
      "openai-bundled",
      "browser",
      "latest",
    )
    await fs.mkdir(path.dirname(latest), { recursive: true })
    await fs.symlink(path.join(testHome, "missing-browser-source"), latest, "junction")

    const status = await cacheLatestStatus("browser")
    assert.equal((await fs.lstat(latest)).isSymbolicLink(), true)
    assert.equal(status.ok, false)
    assert.equal(status.targetPath, "")
  } finally {
    process.env.CODEX_HOME = previousHome
    await fs.rm(testHome, { recursive: true, force: true })
  }
})

test("repair removes dangling latest junctions and is idempotent", async () => {
  const previousHome = process.env.CODEX_HOME
  const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "switchgate-plugin-repair-"))
  process.env.CODEX_HOME = testHome
  try {
    const source = path.join(testHome, "source", "plugins", "browser")
    const latest = path.join(
      testHome,
      "plugins",
      "cache",
      "openai-bundled",
      "browser",
      "latest",
    )
    await fs.mkdir(path.join(source, ".codex-plugin"), { recursive: true })
    await fs.writeFile(
      path.join(source, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "browser", version: "test" }),
      "utf8",
    )
    await fs.mkdir(path.dirname(latest), { recursive: true })
    await fs.symlink(path.join(testHome, "missing-browser-source"), latest, "junction")

    assert.equal(await repairPluginLatest("browser", source), true)
    const repaired = await cacheLatestStatus("browser")
    assert.equal(repaired.ok, true)
    assert.equal(samePath(repaired.targetPath, await fs.realpath(source)), true)
    assert.equal(await repairPluginLatest("browser", source), false)
  } finally {
    process.env.CODEX_HOME = previousHome
    await fs.rm(testHome, { recursive: true, force: true })
  }
})
