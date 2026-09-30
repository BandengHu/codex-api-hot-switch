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
  selectDirectory(initialPath = "") {
    return ipcRenderer.invoke("codex-hot-switch-select-directory", {
      initialPath: typeof initialPath === "string" ? initialPath : "",
    })
  },
  /** 用系统默认浏览器打开 http/https 外链（授权登录走这条）。 */
  openExternal(url) {
    return ipcRenderer.invoke("codex-hot-switch-open-external", {
      url: typeof url === "string" ? url : "",
    })
  },
  onDesktopMessage(callback) {
    if (typeof callback !== "function") return () => undefined
    const listener = (_event, message) => callback(message)
    ipcRenderer.on("codex-hot-switch-desktop", listener)
    return () => ipcRenderer.removeListener("codex-hot-switch-desktop", listener)
  },
})
