const { contextBridge, ipcRenderer } = require("electron")

const CHANNELS = new Set([
  "codex-hot-switch-floating",
  "codex-hot-switch-floating-panel",
  "codex-hot-switch-console",
])

contextBridge.exposeInMainWorld("codexHotSwitchFloating", {
  send(channel, message) {
    if (!CHANNELS.has(channel)) return
    ipcRenderer.send(channel, message)
  },
  onDesktopMessage(callback) {
    if (typeof callback !== "function") return () => undefined
    const listener = (_event, message) => callback(message)
    ipcRenderer.on("codex-hot-switch-desktop", listener)
    return () => ipcRenderer.removeListener("codex-hot-switch-desktop", listener)
  },
})
