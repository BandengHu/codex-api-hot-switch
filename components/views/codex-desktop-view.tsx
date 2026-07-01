"use client"

import { MonitorCog } from "lucide-react"
import { CodexAccessPanel } from "@/components/codex-access-panel"
import { CodexPluginDoctorPanel } from "@/components/codex-plugin-doctor-panel"
import { CodexModelWhitelistPanel } from "@/components/codex-model-whitelist-panel"

export function CodexDesktopView() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <MonitorCog className="size-5" />
            Codex 桌面端
          </h1>
          <p className="text-sm text-muted-foreground">
            管理 Codex 桌面端接入、插件路径、Chrome native host 与更新后的修复
          </p>
        </div>
      </div>

      <CodexAccessPanel />
      <CodexModelWhitelistPanel />
      <CodexPluginDoctorPanel />
    </div>
  )
}
