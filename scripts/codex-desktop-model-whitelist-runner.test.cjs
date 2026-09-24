const assert = require("node:assert/strict")
const test = require("node:test")

const {
  CODEX_DESKTOP_PROCESS_FILTER,
  codexExecutableCandidates,
  compareVersionStringsDescending,
  isAuxiliaryWindowTarget,
  isCodexAppServerProcess,
  isCodexMainWindowTarget,
  isCodexPage,
  isDesktopCodexMainProcess,
  isDesktopCodexProcess,
  pickCodexTarget,
  parseVersionFromInstallPath,
  processInstallPath,
  sameInstallPath,
} = require("./codex-desktop-model-whitelist-runner.cjs")

const latestInstall =
  "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.730.7989.0_x64__2p2nqsd0c76g0"

//取自2026-09-25本机 Codex26.917.9434.0的真实 /json/list结果。
const liveMainWindowTarget = {
  type: "page",
  id: "EE54D435663668929CEFDBA10A0A0E6F",
  title: "回复问候",
  url: "app://-/index.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/EE54D435663668929CEFDBA10A0A0E6F",
}

const liveAvatarOverlayTarget = {
  type: "page",
  id: "A78A471813B30D6FDC2938B087EA109A",
  title: "ChatGPT",
  url: "app://-/index.html?initialRoute=%2Favatar-overlay",
  webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/page/A78A471813B30D6FDC2938B087EA109A",
}

test("new Codex main window is picked even when its title has no codex word", () => {
  assert.equal(isCodexPage(liveMainWindowTarget), false)
  assert.equal(isCodexMainWindowTarget(liveMainWindowTarget), true)
  assert.equal(pickCodexTarget([liveMainWindowTarget])?.id, liveMainWindowTarget.id)
})

test("auxiliary windows with initialRoute are never chosen", () => {
  assert.equal(isAuxiliaryWindowTarget(liveAvatarOverlayTarget), true)
  assert.equal(isAuxiliaryWindowTarget(liveMainWindowTarget), false)
  assert.equal(isCodexMainWindowTarget(liveAvatarOverlayTarget), false)
  assert.equal(
    pickCodexTarget([liveAvatarOverlayTarget])?.id,
    undefined,
    "只有附加窗口时应当返回 null，而不是把补丁注入到浮层里",
  )
})

test("main window wins over the avatar overlay when both are open", () => {
  assert.equal(
    pickCodexTarget([liveAvatarOverlayTarget, liveMainWindowTarget])?.id,
    liveMainWindowTarget.id,
  )
  assert.equal(
    pickCodexTarget([liveMainWindowTarget, liveAvatarOverlayTarget])?.id,
    liveMainWindowTarget.id,
  )
})

test("legacy targets whose title contains codex keep working", () => {
  const legacy = { type: "page", title: "Codex", url: "app://-/index.html", webSocketDebuggerUrl: "ws://x" }
  assert.equal(pickCodexTarget([legacy])?.title, "Codex")
})

test("targets without a debugger url or of other types are ignored", () => {
  const serviceWorker = { type: "service_worker", title: "Codex", url: "app://-/sw.js", webSocketDebuggerUrl: "ws://x" }
  const pageWithoutWs = { type: "page", title: "回复问候", url: "app://-/index.html" }
  assert.equal(pickCodexTarget([serviceWorker, pageWithoutWs]), null)
})

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
