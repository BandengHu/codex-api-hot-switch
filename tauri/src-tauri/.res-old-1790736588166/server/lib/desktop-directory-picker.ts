"use client"

type DirectoryPickerResult = {
  canceled?: boolean
  path?: string
}

type DesktopBridge = {
  selectDirectory?: (initialPath?: string) => Promise<DirectoryPickerResult>
}

export async function selectDesktopDirectory(initialPath = "") {
  const bridge = (
    window as unknown as {
      codexHotSwitchFloating?: DesktopBridge
    }
  ).codexHotSwitchFloating

  if (!bridge?.selectDirectory) {
    throw new Error("文件夹选择仅在 Codex SwitchGate 安装版中可用")
  }

  const result = await bridge.selectDirectory(initialPath)
  if (result?.canceled) return ""
  return typeof result?.path === "string" ? result.path.trim() : ""
}
