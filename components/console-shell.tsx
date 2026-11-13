"use client"

import { useCallback, useEffect, useState } from "react"
import { Sidebar } from "@/components/sidebar"
import {
  DEFAULT_VIEW,
  defaultViewForMode,
  resolveView,
  type ViewKey,
} from "@/lib/console-views"
import { Topbar } from "@/components/topbar"
import { DashboardView } from "@/components/views/dashboard-view"
import { ProvidersView } from "@/components/views/providers-view"
import { ModelsView } from "@/components/views/models-view"
import { SwitchView } from "@/components/views/switch-view"
import { TokenStatsView } from "@/components/views/token-stats-view"
import { LogsView } from "@/components/views/logs-view"
import { CodexDesktopView } from "@/components/views/codex-desktop-view"
import { CodexSessionsView } from "@/components/views/codex-sessions-view"
import { WecomBridgeView } from "@/components/views/wecom-bridge-view"
import { WorkbuddyPoolView } from "@/components/views/workbuddy-pool-view"
import { WorkbuddyGlobalPoolView } from "@/components/views/workbuddy-global-pool-view"
import { SettingsView } from "@/components/views/settings-view"
import { AccountsView } from "@/components/views/accounts-view"
import { McpView } from "@/components/views/mcp-view"

function viewFromUrl(serverMode: boolean) {
  const params = new URLSearchParams(window.location.search)
  return resolveView(params.get("view"), serverMode)
}

export function ConsoleShell({
  initialView = DEFAULT_VIEW,
  serverMode = false,
}: {
  initialView?: ViewKey
  serverMode?: boolean
}) {
  const [view, setView] = useState<ViewKey>(initialView)

  useEffect(() => {
    setView(viewFromUrl(serverMode))
    const handlePopState = () => setView(viewFromUrl(serverMode))
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [serverMode])

  const navigate = useCallback((nextView: ViewKey) => {
    setView(nextView)
    const url = new URL(window.location.href)
    if (nextView === defaultViewForMode(serverMode)) url.searchParams.delete("view")
    else url.searchParams.set("view", nextView)
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }, [serverMode])

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <Sidebar active={view} onNavigate={navigate} serverMode={serverMode} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto w-full max-w-6xl">
            {view === "dashboard" ? <DashboardView /> : null}
            {view === "providers" ? <ProvidersView /> : null}
            {view === "models" ? <ModelsView /> : null}
            {view === "switch" ? <SwitchView /> : null}
            {view === "token-stats" ? <TokenStatsView /> : null}
            {view === "logs" ? <LogsView /> : null}
            {view === "codex-desktop" ? <CodexDesktopView /> : null}
            {view === "mcp" ? <McpView /> : null}
            {view === "codex-sessions" ? <CodexSessionsView /> : null}
            {view === "wecom-bridge" ? <WecomBridgeView /> : null}
            {view === "workbuddy-pool" ? <WorkbuddyPoolView /> : null}
            {view === "workbuddy-global-pool" ? <WorkbuddyGlobalPoolView /> : null}
            {view === "accounts" && serverMode ? <AccountsView /> : null}
            {view === "settings" ? <SettingsView /> : null}
          </div>
        </main>
      </div>
    </div>
  )
}
