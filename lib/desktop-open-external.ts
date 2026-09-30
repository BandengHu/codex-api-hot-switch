"use client"

type OpenExternalResult = {
  ok?: boolean
  error?: string
}

type DesktopBridge = {
  openExternal?: (url: string) => Promise<OpenExternalResult>
}

/** Tauri 的全局对象（`app.withGlobalTauri: true` 时由外壳注入）。 */
type TauriGlobal = {
  core?: {
    invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  }
  opener?: {
    openUrl?: (url: string) => Promise<void>
  }
}

function tauriGlobal(): TauriGlobal | undefined {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
}

/**
 * 用系统默认浏览器打开外链。
 *
 * 安装版里 `window.open` 会开一个应用内窗口（Electron 的 BrowserWindow / Tauri 的
 * 新 WebviewWindow）—— 授权登录页面在那个窗口里既不好完成授权、也回不到控制台，
 * 所以统一交给外壳调系统浏览器。两条桥都支持：
 *
 * 1. Electron：preload 暴露的 `window.codexHotSwitchFloating.openExternal`
 *    → 主进程 `shell.openExternal`。
 * 2. Tauri：`window.__TAURI__.opener.openUrl`（走 opener 插件）。
 *
 * 浏览器里直接调试时没有任何桥，退化成 `window.open`。
 */
export async function openExternalUrl(url: string): Promise<void> {
  const target = url.trim()
  if (!target) throw new Error("授权链接为空，请重新获取")

  const bridge = (window as unknown as { codexHotSwitchFloating?: DesktopBridge })
    .codexHotSwitchFloating

  if (bridge?.openExternal) {
    const result = await bridge.openExternal(target)
    if (result?.ok) return
    throw new Error(result?.error || "系统浏览器打开失败")
  }

  // Tauri 外壳：没有 Electron 桥，但注入了 __TAURI__。
  const tauri = tauriGlobal()
  if (tauri?.opener?.openUrl) {
    await tauri.opener.openUrl(target)
    return
  }

  window.open(target, "_blank", "noopener,noreferrer")
}
