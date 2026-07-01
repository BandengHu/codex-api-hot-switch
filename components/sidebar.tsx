"use client"

import {
  LayoutDashboard,
  Server,
  Boxes,
  ChartLine,
  GitMerge,
  MessagesSquare,
  MonitorCog,
  Zap,
  ScrollText,
  Settings as SettingsIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"

export type ViewKey =
  | "dashboard"
  | "providers"
  | "models"
  | "switch"
  | "token-stats"
  | "logs"
  | "codex-desktop"
  | "codex-sessions"
  | "wecom-bridge"
  | "settings"

export const DEFAULT_VIEW: ViewKey = "codex-desktop"

const NAV_ITEMS: { key: ViewKey; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "dashboard", label: "总览", icon: LayoutDashboard },
  { key: "providers", label: "供应商", icon: Server },
  { key: "models", label: "模型", icon: Boxes },
  { key: "switch", label: "热切换", icon: Zap },
  { key: "token-stats", label: "Token 统计", icon: ChartLine },
  { key: "logs", label: "请求日志", icon: ScrollText },
  { key: "codex-desktop", label: "Codex 桌面端", icon: MonitorCog },
  { key: "codex-sessions", label: "同步会话", icon: GitMerge },
  { key: "wecom-bridge", label: "企业微信机器人", icon: MessagesSquare },
  { key: "settings", label: "设置", icon: SettingsIcon },
]

export function isViewKey(value: unknown): value is ViewKey {
  return NAV_ITEMS.some((item) => item.key === value)
}

function viewHref(view: ViewKey) {
  return view === DEFAULT_VIEW ? "/" : `/?view=${view}`
}

export function Sidebar({
  active,
  onNavigate,
}: {
  active: ViewKey
  onNavigate: (key: ViewKey) => void
}) {
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
          <span className="text-[11px] text-muted-foreground">本地模型热切换中转</span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = active === item.key
          return (
            <a
              key={item.key}
              href={viewHref(item.key)}
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
          本地运行
          <br />
          实时中转 · 桌面控制台
        </p>
      </div>
    </aside>
  )
}
