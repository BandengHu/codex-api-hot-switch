"use client"

import { ConsoleShell } from "@/components/console-shell"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ConsoleProvider } from "@/lib/console-store"
import { ThemeProvider } from "@/lib/theme-provider"
import { DEFAULT_VIEW, type ViewKey } from "./sidebar"

export function AppRoot({ initialView = DEFAULT_VIEW }: { initialView?: ViewKey }) {
  return (
    <ThemeProvider>
      <ConsoleProvider>
        <TooltipProvider>
          <ConsoleShell initialView={initialView} />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </ConsoleProvider>
    </ThemeProvider>
  )
}
