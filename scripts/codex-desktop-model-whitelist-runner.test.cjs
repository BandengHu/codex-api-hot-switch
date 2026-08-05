const assert = require("node:assert/strict")
const test = require("node:test")

const {
  CODEX_DESKTOP_PROCESS_FILTER,
  codexExecutableCandidates,
  compareVersionStringsDescending,
  isCodexAppServerProcess,
  isDesktopCodexMainProcess,
  isDesktopCodexProcess,
  parseVersionFromInstallPath,
  processInstallPath,
  sameInstallPath,
} = require("./codex-desktop-model-whitelist-runner.cjs")

const latestInstall =
  "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.730.7989.0_x64__2p2nqsd0c76g0"

test("Codex package versions are compared numerically", () => {
  assert.equal(compareVersionStringsDescending("26.730.7989.0", "26.727.6591.0"), -3)
  assert.equal(compareVersionStringsDescending("26.8.0.0", "26.730.0.0"), 722)
  assert.equal(parseVersionFromInstallPath(latestInstall), "26.730.7989.0")
})

test("new ChatGPT.exe desktop process is recognized as Codex", () => {
  const processInfo = {
    executablePath: `${latestInstall}\\app\\ChatGPT.exe`,
    commandLine: `"${latestInstall}\\app\\ChatGPT.exe" --remote-debugging-port=9229`,
  }
  assert.equal(isDesktopCodexProcess(processInfo), true)
  assert.equal(isDesktopCodexMainProcess(processInfo), true)
  assert.equal(processInstallPath(processInfo), latestInstall)
})

test("desktop process query includes the new ChatGPT.exe name", () => {
  assert.match(CODEX_DESKTOP_PROCESS_FILTER, /ChatGPT\.exe/)
  assert.match(CODEX_DESKTOP_PROCESS_FILTER, /Codex\.exe/)
})

test("ChatGPT renderer is not treated as the main process", () => {
  const processInfo = {
    executablePath: `${latestInstall}\\app\\ChatGPT.exe`,
    commandLine: `"${latestInstall}\\app\\ChatGPT.exe" --type=renderer`,
  }
  assert.equal(isDesktopCodexProcess(processInfo), true)
  assert.equal(isDesktopCodexMainProcess(processInfo), false)
})

test("packaged app server is recognized without matching unrelated CLI processes", () => {
  assert.equal(
    isCodexAppServerProcess({
      executablePath: `${latestInstall}\\app\\resources\\codex.exe`,
      commandLine: `"${latestInstall}\\app\\resources\\codex.exe" app-server`,
    }),
    true,
  )
  assert.equal(
    isCodexAppServerProcess({
      executablePath: "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.exe",
      commandLine: "codex.exe app-server",
    }),
    false,
  )
})

test("install path comparison ignores case and slash style", () => {
  assert.equal(
    sameInstallPath(latestInstall, latestInstall.toLowerCase().replaceAll("\\", "/")),
    true,
  )
})

test("desktop executable discovery prefers the new ChatGPT.exe name", () => {
  assert.match(codexExecutableCandidates(latestInstall)[0], /\\app\\ChatGPT\.exe$/i)
})
