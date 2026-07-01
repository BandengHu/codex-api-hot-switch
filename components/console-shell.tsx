"use client"

import { useCallback, useEffect, useState } from "react"
import { DEFAULT_VIEW, Sidebar, isViewKey, type ViewKey } from "@/components/sidebar"
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
import { SettingsView } from "@/components/views/settings-view"

function viewFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const view = params.get("view")
  return isViewKey(view) ? view : DEFAULT_VIEW
}

export function ConsoleShell({
  initialView = DEFAULT_VIEW,
}: {
  initialView?: ViewKey
}) {
  const [view, setView] = useState<ViewKey>(initialView)

  useEffect(() => {
    setView(viewFromUrl())
    const handlePopState = () => setView(viewFromUrl())
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  const navigate = useCallback((nextView: ViewKey) => {
    setView(nextView)
    const url = new URL(window.location.href)
    if (nextView === DEFAULT_VIEW) url.searchParams.delete("view")
    else url.searchParams.set("view", nextView)
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }, [])

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <Sidebar active={view} onNavigate={navigate} />
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
            {view === "codex-sessions" ? <CodexSessionsView /> : null}
            {view === "wecom-bridge" ? <WecomBridgeView /> : null}
            {view === "settings" ? <SettingsView /> : null}
          </div>
        </main>
      </div>
    </div>
  )
}
