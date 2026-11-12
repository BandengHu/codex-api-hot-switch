export type ViewKey =
  | "dashboard"
  | "providers"
  | "models"
  | "switch"
  | "token-stats"
  | "logs"
  | "codex-desktop"
  | "mcp"
  | "codex-sessions"
  | "wecom-bridge"
  | "workbuddy-pool"
  | "workbuddy-global-pool"
  | "settings"

export const DEFAULT_VIEW: ViewKey = "codex-desktop"
export const SERVER_DEFAULT_VIEW: ViewKey = "dashboard"

/**
 * 服务器网页没有本机 Codex 桌面环境，也没有可用的同步会话和企微运行态。
 * 这些入口只在服务器 UI 中隐藏，API 和本机桌面版保持原样。
 */
export const SERVER_HIDDEN_VIEWS: ReadonlySet<ViewKey> = new Set<ViewKey>([
  "codex-desktop",
  "mcp",
  "codex-sessions",
  "wecom-bridge",
])

export const VIEW_KEYS: readonly ViewKey[] = [
  "dashboard",
  "providers",
  "models",
  "switch",
  "token-stats",
  "logs",
  "codex-desktop",
  "mcp",
  "codex-sessions",
  "wecom-bridge",
  "workbuddy-pool",
  "workbuddy-global-pool",
  "settings",
]

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === "string" && (VIEW_KEYS as readonly string[]).includes(value)
}

export function defaultViewForMode(serverMode: boolean): ViewKey {
  return serverMode ? SERVER_DEFAULT_VIEW : DEFAULT_VIEW
}

export function isViewVisible(view: ViewKey, serverMode: boolean) {
  return !serverMode || !SERVER_HIDDEN_VIEWS.has(view)
}

export function resolveView(value: unknown, serverMode: boolean): ViewKey {
  const raw = Array.isArray(value) ? value[0] : value
  return isViewKey(raw) && isViewVisible(raw, serverMode)
    ? raw
    : defaultViewForMode(serverMode)
}
