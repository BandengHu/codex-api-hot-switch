"use client"

/** Tauri 的全局对象（`app.withGlobalTauri: true` 时由外壳注入）。 */
type TauriGlobal = {
  core?: {
    invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  }
}

/** Tauri dialog 插件 `open` 命令的返回：未取消时是字符串路径或路径数组。 */
type TauriDialogResult = string | string[] | null

/**
 * 弹系统「选择文件夹」对话框，返回绝对路径；用户取消则返回空串。
 *
 * Tauri 通过 `invoke("plugin:dialog|open")` 打开系统对话框；浏览器里没有桥，
 * 抛错提示仅安装版可用。
 */
export async function selectDesktopDirectory(initialPath = "") {
  const invoke = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__?.core
    ?.invoke
  if (invoke) {
    const picked = await invoke<TauriDialogResult>("plugin:dialog|open", {
      options: {
        directory: true,
        multiple: false,
        defaultPath: initialPath || undefined,
        title: "选择文件夹",
      },
    })
    if (!picked) return ""
    return (Array.isArray(picked) ? picked[0] : picked).trim()
  }

  throw new Error("文件夹选择仅在 Codex SwitchGate 安装版中可用")
}
