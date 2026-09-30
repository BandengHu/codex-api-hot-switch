"use client"

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
 * 安装版里 `window.open` 会开一个应用内窗口，授权登录页面无法正常返回控制台。
 * Tauri 外壳通过 opener 插件调用系统浏览器；浏览器调试时退化成 `window.open`。
 */
export async function openExternalUrl(url: string): Promise<void> {
  const target = url.trim()
  if (!target) throw new Error("授权链接为空，请重新获取")

  const tauri = tauriGlobal()
  if (tauri?.opener?.openUrl) {
    await tauri.opener.openUrl(target)
    return
  }

  window.open(target, "_blank", "noopener,noreferrer")
}
