const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  dialog,
  clipboard,
  nativeImage,
  screen,
  shell,
} = require("electron")
const { spawn } = require("node:child_process")
const { existsSync, mkdirSync, openSync, readdirSync } = require("node:fs")
const net = require("node:net")
const { homedir } = require("node:os")
const path = require("node:path")
const {
  APP_STORAGE_NAME,
  resolveServerRuntimeConfig,
} = require("./server-runtime-config.cjs")

const START_TIMEOUT_MS = 30000
const FLOATING_BALL_SIZE = 64
const FLOATING_PANEL_WIDTH = 320
const FLOATING_PANEL_HEIGHT = 360
const FLOATING_SETTINGS_POLL_MS = 1200
const SERVER_HEALTH_POLL_MS = 5000
const SERVER_RESTART_DELAY_MS = 1500
const SERVER_MAX_RESTARTS = 5
const SERVER_RESTART_WINDOW_MS = 5 * 60 * 1000

app.setName(APP_STORAGE_NAME)

let mainWindow = null
let floatingBallWindow = null
let floatingPanelWindow = null
let tray = null
let serverProcess = null
let isQuitting = false
let runtime = null
let floatingSettingsPoll = null
let serverHealthPoll = null
let serverStartPromise = null
let intentionalServerRestart = false
let serverStatus = {
  state: "starting",
  message: "正在启动本地中转服务",
  owned: false,
}
let consoleSummary = {
  takeover: "unknown",
  provider: "",
  model: "",
  reasoning: "",
}
const serverRestartHistory = []

function currentRuntime() {
  if (!runtime) runtime = resolveServerRuntimeConfig({ root: appRoot() })
  return runtime
}

function appUrl() {
  return currentRuntime().appUrl
}

function endpointLabel() {
  const config = currentRuntime()
  return `${config.host}:${config.port}`
}

function appPage(pathname) {
  return `${appUrl()}${pathname}`
}

function isDevelopment() {
  return process.env.ELECTRON_DEV === "1" || !app.isPackaged
}

function appRoot() {
  return isDevelopment()
    ? path.resolve(__dirname, "..")
    : path.resolve(process.resourcesPath, "app")
}

function preloadPath() {
  return path.join(__dirname, "floating-preload.cjs")
}

function iconPath() {
  const root = appRoot()
  const candidates = [
    path.join(root, "public", "app-icon-switch-64.png"),
    path.join(root, "public", "app-icon-switch-32.png"),
    path.join(root, "public", "app-icon-switch-512.png"),
    path.join(root, "public", "icon-light-32x32.png"),
    path.join(root, "public", "icon-dark-32x32.png"),
    path.join(root, "public", "apple-icon.png"),
  ]
  return candidates.find((candidate) => existsSync(candidate)) || ""
}

function createIcon() {
  const file = iconPath()
  if (!file) return nativeImage.createEmpty()
  return nativeImage.createFromPath(file)
}

function appDataRoot() {
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"),
      APP_STORAGE_NAME,
    )
  }
  if (process.platform === "darwin") {
    return path.join(
      homedir(),
      "Library",
      "Application Support",
      APP_STORAGE_NAME,
    )
  }
  return path.join(
    process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"),
    APP_STORAGE_NAME,
  )
}

function serverLogFiles() {
  const logDir = path.join(appDataRoot(), "logs")
  mkdirSync(logDir, { recursive: true })
  return {
    stdout: path.join(logDir, "server.out.log"),
    stderr: path.join(logDir, "server.err.log"),
  }
}

function serverStdio() {
  const logs = serverLogFiles()
  return ["ignore", openSync(logs.stdout, "a"), openSync(logs.stderr, "a")]
}

function setServerStatus(next) {
  serverStatus = {
    ...serverStatus,
    ...next,
  }
  refreshTray()
  broadcastDesktopState()
}

function broadcastDesktopState() {
  const payload = {
    type: "desktop-state",
    payload: {
      server: serverStatus,
      console: consoleSummary,
      floatingBallVisible: Boolean(floatingBallWindow && !floatingBallWindow.isDestroyed()),
      appUrl: appUrl(),
    },
  }
  for (const window of [mainWindow, floatingPanelWindow, floatingBallWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("codex-hot-switch-desktop", payload)
    }
  }
}

function broadcastConsoleChanged(source) {
  void fetchConsoleSnapshot()
    .then(updateConsoleSummary)
    .catch(() => undefined)
  for (const window of [mainWindow, floatingPanelWindow, floatingBallWindow]) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("codex-hot-switch-desktop", {
        type: "console-changed",
        payload: { source },
      })
    }
  }
  refreshTray()
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function checkPortAvailable(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolve(false)
        return
      }
      reject(error)
    })
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

async function assertPortAvailable() {
  const config = currentRuntime()
  const bindHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host
  const available = await checkPortAvailable(bindHost, config.port)
  if (!available) {
    throw new Error(
      `端口 ${endpointLabel()} 已被占用，且该端口不是正在运行的 Codex SwitchGate 服务。请关闭占用进程或在设置里改端口。`,
    )
  }
}

function rememberServerRestart() {
  const now = Date.now()
  serverRestartHistory.push(now)
  while (
    serverRestartHistory.length > 0 &&
    now - serverRestartHistory[0] > SERVER_RESTART_WINDOW_MS
  ) {
    serverRestartHistory.shift()
  }
  return serverRestartHistory.length
}

function attachServerProcessHandlers() {
  if (!serverProcess) return
  const processRef = serverProcess
  processRef.once("exit", (code, signal) => {
    if (serverProcess === processRef) serverProcess = null
    if (isQuitting) return
    if (intentionalServerRestart) return
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
    handleServerExit(reason)
  })
  processRef.once("error", (error) => {
    if (serverProcess === processRef) serverProcess = null
    if (isQuitting) return
    if (intentionalServerRestart) return
    handleServerExit(error instanceof Error ? error.message : String(error))
  })
}

function handleServerExit(reason) {
  const restartCount = rememberServerRestart()
  if (restartCount > SERVER_MAX_RESTARTS) {
    setServerStatus({
      state: "failed",
      message: `本地服务反复崩溃，已停止自动重启：${reason}`,
      owned: false,
    })
    return
  }
  setServerStatus({
    state: "restarting",
    message: `本地服务已退出，准备自动重启：${reason}`,
    owned: false,
  })
  setTimeout(() => {
    void ensureServer({ forceStart: true }).catch((error) => {
      setServerStatus({
        state: "failed",
        message: error instanceof Error ? error.message : String(error),
        owned: false,
      })
    })
  }, SERVER_RESTART_DELAY_MS)
}

function packagedNodePath(root) {
  const vendorPath = path.join(root, "vendor")
  const pnpmPath = path.join(vendorPath, ".pnpm")
  const entries = [vendorPath]
  if (existsSync(pnpmPath)) {
    for (const name of readdirSync(pnpmPath)) {
      const modulePath = path.join(pnpmPath, name, "node_modules")
      if (existsSync(modulePath)) entries.push(modulePath)
    }
  }
  return entries.join(path.delimiter)
}

async function waitForServer() {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < START_TIMEOUT_MS) {
    try {
      const response = await fetch(`${appUrl()}/api/console`, { cache: "no-store" })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(
    `本地中转服务启动超时：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

async function serverAlreadyRunning() {
  try {
    const response = await fetch(`${appUrl()}/api/console`, { cache: "no-store" })
    return response.ok
  } catch {
    return false
  }
}

function startDevServer() {
  const root = appRoot()
  const runtime = currentRuntime()
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next")
  if (!existsSync(nextBin)) {
    throw new Error(`缺少 Next 开发服务入口：${nextBin}`)
  }
  serverProcess = spawn(process.execPath, [nextBin, "dev", "--hostname", runtime.host, "--port", String(runtime.port)], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOT_SWITCH_DATA_DIR: runtime.dataDir,
      HOSTNAME: runtime.host,
      PORT: String(runtime.port),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: serverStdio(),
    windowsHide: true,
  })
  attachServerProcessHandlers()
}

function startPackagedServer() {
  const root = appRoot()
  const runtime = currentRuntime()
  const serverFile = path.join(root, "server.js")
  const vendorPath = path.join(root, "vendor")
  if (!existsSync(serverFile)) {
    throw new Error(`缺少 Next 服务文件：${serverFile}`)
  }
  if (!existsSync(vendorPath)) {
    throw new Error(`缺少 Next 服务依赖目录：${vendorPath}`)
  }
  serverProcess = spawn(process.execPath, [serverFile], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEX_HOT_SWITCH_DATA_DIR: runtime.dataDir,
      HOSTNAME: runtime.host,
      NODE_PATH: packagedNodePath(root),
      PORT: String(runtime.port),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: serverStdio(),
    windowsHide: true,
  })
  attachServerProcessHandlers()
}

async function startOwnedServer() {
  await assertPortAvailable()
  if (isDevelopment()) startDevServer()
  else startPackagedServer()
  setServerStatus({
    state: "starting",
    message: `正在启动本地中转服务：${endpointLabel()}`,
    owned: true,
  })
  await waitForServer()
  setServerStatus({
    state: "running",
    message: `本地中转服务运行中：${endpointLabel()}`,
    owned: true,
  })
}

async function ensureServer(options = {}) {
  if (serverStartPromise) return serverStartPromise
  serverStartPromise = (async () => {
    if (!options.forceStart && (await serverAlreadyRunning())) {
      setServerStatus({
        state: "running",
        message: `已连接正在运行的本地中转服务：${endpointLabel()}`,
        owned: false,
      })
      return
    }
    await startOwnedServer()
  })().finally(() => {
    serverStartPromise = null
  })
  return serverStartPromise
}

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function hideMainWindowToTray(event) {
  if (isQuitting) return
  event?.preventDefault?.()
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
  refreshTray()
}

function quitApp() {
  isQuitting = true
  app.quit()
}

function visibleDisplayBounds() {
  return screen.getPrimaryDisplay().workArea
}

function clampFloatingPosition(position) {
  const bounds = visibleDisplayBounds()
  const x = Math.min(
    Math.max(Math.round(Number(position?.x) || 0), bounds.x),
    bounds.x + bounds.width - FLOATING_BALL_SIZE,
  )
  const y = Math.min(
    Math.max(Math.round(Number(position?.y) || 0), bounds.y),
    bounds.y + bounds.height - FLOATING_BALL_SIZE,
  )
  return { x, y }
}

function defaultFloatingPosition() {
  const bounds = visibleDisplayBounds()
  return {
    x: bounds.x + bounds.width - FLOATING_BALL_SIZE - 24,
    y: bounds.y + Math.round(bounds.height * 0.58),
  }
}

async function fetchConsoleSnapshot() {
  const response = await fetch(`${appUrl()}/api/console`, { cache: "no-store" })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function updateConsoleSummary(snapshot) {
  const provider = snapshot.providers?.find(
    (item) => item.id === snapshot.runtime?.activeProviderId,
  )
  const model = snapshot.models?.find(
    (item) => item.id === snapshot.runtime?.activeModelId,
  )
  consoleSummary = {
    takeover: snapshot.runtime?.takeover || "unknown",
    provider: provider?.name || "",
    model: model?.displayName || "",
    reasoning: snapshot.runtime?.reasoning || "",
  }
  refreshTray()
  broadcastDesktopState()
}

async function saveFloatingSettings(body) {
  await fetch(`${appUrl()}/api/settings/floating-ball`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined)
}

function hideFloatingPanel() {
  if (!floatingPanelWindow) return
  floatingPanelWindow.hide()
}

function positionFloatingPanel() {
  if (!floatingBallWindow || !floatingPanelWindow) return
  const ballBounds = floatingBallWindow.getBounds()
  const display = screen.getDisplayMatching(ballBounds).workArea
  const rightSideSpace = display.x + display.width - (ballBounds.x + ballBounds.width)
  const panelX =
    rightSideSpace >= FLOATING_PANEL_WIDTH + 16
      ? ballBounds.x + ballBounds.width + 8
      : ballBounds.x - FLOATING_PANEL_WIDTH - 8
  const panelY = Math.min(
    Math.max(ballBounds.y - Math.round((FLOATING_PANEL_HEIGHT - ballBounds.height) / 2), display.y),
    display.y + display.height - FLOATING_PANEL_HEIGHT,
  )
  floatingPanelWindow.setBounds({
    x: Math.round(panelX),
    y: Math.round(panelY),
    width: FLOATING_PANEL_WIDTH,
    height: FLOATING_PANEL_HEIGHT,
  })
}

function toggleFloatingPanel() {
  if (!floatingPanelWindow) return
  if (floatingPanelWindow.isVisible()) {
    floatingPanelWindow.hide()
    return
  }
  positionFloatingPanel()
  floatingPanelWindow.show()
  floatingPanelWindow.focus()
}

function buildFloatingMenu() {
  return Menu.buildFromTemplate([
    { label: "打开控制台", click: showWindow },
    {
      label: "隐藏悬浮球",
      click: () => {
        void saveFloatingSettings({ enabled: false })
        destroyFloatingWindows()
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitApp()
      },
    },
  ])
}

function createFloatingPanelWindow() {
  if (floatingPanelWindow && !floatingPanelWindow.isDestroyed()) return floatingPanelWindow
  floatingPanelWindow = new BrowserWindow({
    width: FLOATING_PANEL_WIDTH,
    height: FLOATING_PANEL_HEIGHT,
    minWidth: FLOATING_PANEL_WIDTH,
    minHeight: FLOATING_PANEL_HEIGHT,
    maxWidth: FLOATING_PANEL_WIDTH,
    maxHeight: FLOATING_PANEL_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath(),
    },
  })
  floatingPanelWindow.setAlwaysOnTop(true, "floating")
  floatingPanelWindow.on("blur", () => floatingPanelWindow?.hide())
  floatingPanelWindow.on("closed", () => {
    floatingPanelWindow = null
  })
  floatingPanelWindow.loadURL(appPage("/floating-panel"))
  return floatingPanelWindow
}

function createFloatingBallWindow(position) {
  if (floatingBallWindow && !floatingBallWindow.isDestroyed()) return floatingBallWindow
  const bounds = clampFloatingPosition(position || defaultFloatingPosition())
  floatingBallWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: FLOATING_BALL_SIZE,
    height: FLOATING_BALL_SIZE,
    minWidth: FLOATING_BALL_SIZE,
    minHeight: FLOATING_BALL_SIZE,
    maxWidth: FLOATING_BALL_SIZE,
    maxHeight: FLOATING_BALL_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath(),
    },
  })
  floatingBallWindow.setAlwaysOnTop(true, "floating")
  floatingBallWindow.once("ready-to-show", () => {
    floatingBallWindow?.showInactive()
  })
  floatingBallWindow.on("closed", () => {
    floatingBallWindow = null
  })
  floatingBallWindow.loadURL(appPage("/floating"))
  createFloatingPanelWindow()
  refreshTray()
  broadcastDesktopState()
  return floatingBallWindow
}

function setupFloatingIpc() {
  ipcMain.on("codex-hot-switch-console", (_event, message) => {
    if (message?.type === "console-changed") {
      broadcastConsoleChanged(message.payload?.source || "renderer")
    }
    if (message?.type === "request-desktop-state") {
      broadcastDesktopState()
    }
    if (message?.type === "restart-server") {
      restartOwnedServer()
    }
  })

  ipcMain.on("codex-hot-switch-floating-panel", (event, message) => {
    if (!floatingPanelWindow || event.sender !== floatingPanelWindow.webContents) return
    if (message?.type === "hide-panel") hideFloatingPanel()
    if (message?.type === "open-console") {
      hideFloatingPanel()
      showWindow()
    }
  })

  ipcMain.on("codex-hot-switch-floating", (event, message) => {
    if (!floatingBallWindow || event.sender !== floatingBallWindow.webContents) return
    if (message?.type === "toggle-panel") toggleFloatingPanel()
    if (message?.type === "context-menu") {
      buildFloatingMenu().popup({ window: floatingBallWindow })
    }
    if (message?.type === "drag-move") {
      const current = floatingBallWindow.getBounds()
      floatingBallWindow.setPosition(
        Math.round(current.x + Number(message.payload?.dx || 0)),
        Math.round(current.y + Number(message.payload?.dy || 0)),
        false,
      )
      hideFloatingPanel()
    }
    if (message?.type === "drag-end") {
      const current = clampFloatingPosition(floatingBallWindow.getBounds())
      floatingBallWindow.setPosition(current.x, current.y, false)
      void saveFloatingSettings({ position: current })
    }
  })
}

function destroyFloatingWindows() {
  if (floatingPanelWindow && !floatingPanelWindow.isDestroyed()) {
    floatingPanelWindow.destroy()
  }
  floatingPanelWindow = null
  if (floatingBallWindow && !floatingBallWindow.isDestroyed()) {
    floatingBallWindow.destroy()
  }
  floatingBallWindow = null
  refreshTray()
  broadcastDesktopState()
}

function stopFloatingSettingsSync() {
  if (!floatingSettingsPoll) return
  clearInterval(floatingSettingsPoll)
  floatingSettingsPoll = null
}

function stopServerHealthSync() {
  if (!serverHealthPoll) return
  clearInterval(serverHealthPoll)
  serverHealthPoll = null
}

async function syncServerHealth() {
  if (serverStatus.state === "starting" || serverStatus.state === "restarting") return
  const running = await serverAlreadyRunning()
  if (running) {
    if (serverStatus.state !== "running") {
      setServerStatus({
        state: "running",
        message: `本地中转服务运行中：${endpointLabel()}`,
        owned: Boolean(serverProcess),
      })
    }
    return
  }
  if (isQuitting) return
  setServerStatus({
    state: "restarting",
    message: "本地中转服务无响应，正在自动拉起",
    owned: false,
  })
  await ensureServer({ forceStart: true }).catch((error) => {
    setServerStatus({
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
      owned: false,
    })
  })
}

function startServerHealthSync() {
  if (serverHealthPoll) return
  serverHealthPoll = setInterval(() => {
    void syncServerHealth()
  }, SERVER_HEALTH_POLL_MS)
}

async function syncFloatingWindows() {
  try {
    const snapshot = await fetchConsoleSnapshot()
    updateConsoleSummary(snapshot)
    if (snapshot.settings?.floatingBallEnabled === false) {
      if (floatingBallWindow || floatingPanelWindow) destroyFloatingWindows()
      return
    }
    createFloatingBallWindow(snapshot.settings?.floatingBallPosition)
  } catch {
    // The server may still be starting; the next poll will retry.
  }
}

function startFloatingSettingsSync() {
  if (floatingSettingsPoll) return
  void syncFloatingWindows()
  floatingSettingsPoll = setInterval(() => {
    void syncFloatingWindows()
  }, FLOATING_SETTINGS_POLL_MS)
}

function buildTrayMenu() {
  const serverStateLabel = {
    starting: "启动中",
    running: "运行中",
    restarting: "重启中",
    failed: "异常",
    stopped: "已停止",
  }[serverStatus.state] || serverStatus.state
  const floatingVisible = Boolean(floatingBallWindow && !floatingBallWindow.isDestroyed())
  const takeoverLabel =
    consoleSummary.takeover === "active"
      ? "接管"
      : consoleSummary.takeover === "paused"
        ? "透传"
        : "未知"
  return Menu.buildFromTemplate([
    {
      label: `服务：${serverStateLabel}`,
      enabled: false,
    },
    {
      label: serverStatus.message || `中转地址：${appUrl()}/v1`,
      enabled: false,
    },
    {
      label: `模式：${takeoverLabel}`,
      enabled: false,
    },
    {
      label:
        consoleSummary.provider || consoleSummary.model
          ? `出口：${consoleSummary.provider || "未知供应商"} / ${consoleSummary.model || "未知模型"}`
          : "出口：读取中",
      enabled: false,
    },
    { type: "separator" },
    { label: "打开控制台", click: showWindow },
    {
      label: "在浏览器打开",
      click: () => shell.openExternal(appUrl()),
    },
    {
      label: "复制中转地址",
      click: () => clipboard.writeText(`${appUrl()}/v1`),
    },
    {
      label: "重启本地服务",
      enabled: serverStatus.owned !== false,
      click: () => {
        restartOwnedServer()
      },
    },
    {
      label: floatingVisible ? "隐藏悬浮球" : "显示悬浮球",
      click: () => {
        const enabled = !floatingVisible
        void saveFloatingSettings({ enabled }).then(() => syncFloatingWindows())
      },
    },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
        })
        refreshTray()
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitApp()
      },
    },
  ])
}

function refreshTray() {
  if (!tray) return
  tray.setToolTip(`Codex SwitchGate\n${serverStatus.message || `${appUrl()}/v1`}`)
  tray.setContextMenu(buildTrayMenu())
}

function createTray() {
  tray = new Tray(createIcon())
  tray.setToolTip("Codex SwitchGate")
  tray.setContextMenu(buildTrayMenu())
  tray.on("click", showWindow)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 680,
    title: "Codex SwitchGate",
    icon: iconPath(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  mainWindow.once("ready-to-show", () => {
    mainWindow.show()
  })
  mainWindow.on("close", hideMainWindowToTray)
  mainWindow.loadURL(appUrl())
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return
  serverProcess.kill()
  serverProcess = null
}

function restartOwnedServer() {
  if (serverStatus.owned === false && !serverProcess) return
  setServerStatus({
    state: "restarting",
    message: "正在重启本地中转服务",
    owned: Boolean(serverProcess),
  })
  const processToStop = serverProcess
  if (processToStop && !processToStop.killed) {
    intentionalServerRestart = true
    processToStop.once("exit", () => {
      intentionalServerRestart = false
      void ensureServer({ forceStart: true }).catch((error) => {
        setServerStatus({
          state: "failed",
          message: error instanceof Error ? error.message : String(error),
          owned: false,
        })
      })
    })
    processToStop.kill()
    return
  }
  void ensureServer({ forceStart: true }).catch((error) => {
    setServerStatus({
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
      owned: false,
    })
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on("second-instance", showWindow)
  app.whenReady().then(async () => {
    try {
      createTray()
      await ensureServer()
      setupFloatingIpc()
      createWindow()
      startServerHealthSync()
      startFloatingSettingsSync()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(message)
      dialog.showErrorBox("Codex SwitchGate 启动失败", message)
      app.quit()
    }
  })
}

app.on("before-quit", () => {
  isQuitting = true
  stopServerHealthSync()
  stopFloatingSettingsSync()
  destroyFloatingWindows()
  stopServer()
})

app.on("window-all-closed", () => {})
