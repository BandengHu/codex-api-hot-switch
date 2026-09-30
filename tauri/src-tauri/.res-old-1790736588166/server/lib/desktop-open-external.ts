"use client"

type OpenExternalResult = {
  ok?: boolean
  error?: string
}

type DesktopBridge = {
  openExternal?: (url: string) => Promise<OpenExternalResult>
}

/**
 * 用系统默认浏览器打开外链。
 *
 * 安装版（Electron）里 `window.open` 会开一个应用内 BrowserWindow —— 授权登录页面在
 * 那个窗口里既不好完成授权、也回不到控制台，所以走 preload 暴露的 IPC 交给
 * `shell.openExternal`。浏览器里调试时没有这个桥，退化成 `window.open`。
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

  window.open(target, "_blank", "noopener,noreferrer")
}
