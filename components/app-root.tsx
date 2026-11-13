"use client"

import { ConsoleShell } from "@/components/console-shell"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ConsoleProvider } from "@/lib/console-store"
import { DEFAULT_VIEW, type ViewKey } from "@/lib/console-views"
import { ThemeProvider } from "@/lib/theme-provider"
import type { ConsoleSnapshot } from "@/lib/types"

export function AppRoot({
  initialView = DEFAULT_VIEW,
  serverMode = false,
  initialSnapshot,
}: {
  initialView?: ViewKey
  serverMode?: boolean
  initialSnapshot: ConsoleSnapshot
}) {
  return (
    <ThemeProvider>
      <ConsoleProvider initialSnapshot={initialSnapshot}>
        <TooltipProvider>
          <ConsoleShell initialView={initialView} serverMode={serverMode} />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ConsoleProvider>
    </ThemeProvider>
  )
}
