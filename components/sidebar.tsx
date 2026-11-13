"use client"

import {
  LayoutDashboard,
  Server,
  Boxes,
  ChartLine,
  GitMerge,
  Globe2,
  MessagesSquare,
  MonitorCog,
  Network,
  Users,
  Zap,
  ScrollText,
  ShieldCheck,
  Settings as SettingsIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  defaultViewForMode,
  isViewVisible,
  type ViewKey,
} from "@/lib/console-views"

export type { ViewKey } from "@/lib/console-views"
export { DEFAULT_VIEW } from "@/lib/console-views"

const NAV_ITEMS: { key: ViewKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "dashboard", label: "总览", icon: LayoutDashboard },
  { key: "providers", label: "供应商", icon: Server },
  { key: "models", label: "模型", icon: Boxes },
  { key: "switch", label: "热切换", icon: Zap },
  { key: "token-stats", label: "Token 统计", icon: ChartLine },
  { key: "logs", label: "请求日志", icon: ScrollText },
  { key: "codex-desktop", label: "Codex 桌面端", icon: MonitorCog },
  { key: "mcp", label: "MCP", icon: Network },
  { key: "codex-sessions", label: "同步会话", icon: GitMerge },
  { key: "wecom-bridge", label: "企业微信机器人", icon: MessagesSquare },
  { key: "workbuddy-pool", label: "WorkBuddy 号池", icon: Users },
  { key: "workbuddy-global-pool", label: "WorkBuddy 国际号池", icon: Globe2 },
  { key: "accounts", label: "账号审批", icon: ShieldCheck },
  { key: "settings", label: "设置", icon: SettingsIcon },
]

export function Sidebar({
  active,
  onNavigate,
  serverMode = false,
}: {
  active: ViewKey
  onNavigate: (key: ViewKey) => void
  serverMode?: boolean
}) {
  const items = NAV_ITEMS.filter((item) => isViewVisible(item.key, serverMode))
  const currentDefault = defaultViewForMode(serverMode)

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Zap className="size-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold text-sidebar-foreground">
            Codex SwitchGate
          </span>
          <span className="text-[11px] text-muted-foreground">
            {serverMode ? "服务器模型热切换中转" : "本地模型热切换中转"}
          </span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {items.map((item) => {
          const Icon = item.icon
          const isActive = active === item.key
          return (
            <a
              key={item.key}
              href={item.key === currentDefault ? "/" : `/?view=${item.key}`}
              aria-current={isActive ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault()
                onNavigate(item.key)
              }}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {item.label}
            </a>
          )
        })}
      </nav>

      <div className="border-t border-border p-3">
        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
          {serverMode ? "服务器运行" : "本地运行"}
          <br />
          {serverMode ? "HTTPS 中转 · 网页控制台" : "实时中转 · 桌面控制台"}
        </p>
      </div>
    </aside>
  )
}
