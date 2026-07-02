"use client"

import { useEffect, useRef, useState } from "react"
import { Cpu, Loader2 } from "lucide-react"
import { FloatingDevtoolsGuard } from "@/components/floating-devtools-guard"
import type { ConsoleSnapshot } from "@/lib/types"
import { cn } from "@/lib/utils"

const CLICK_MOVE_TOLERANCE = 4

declare global {
  interface Window {
    codexHotSwitchFloating?: {
      send: (channel: string, message: unknown) => void
      onDesktopMessage?: (callback: (message: unknown) => void) => () => void
    }
  }
}

async function fetchSnapshot() {
  const response = await fetch("/api/console", { cache: "no-store" })
  if (!response.ok) throw new Error("读取状态失败")
  return (await response.json()) as ConsoleSnapshot
}

export function FloatingBallView() {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    lastX: number
    lastY: number
    totalDx: number
    totalDy: number
  } | null>(null)

  useEffect(() => {
    const rootBackground = document.documentElement.style.background
    const bodyBackground = document.body.style.background
    const bodyOverflow = document.body.style.overflow
    document.documentElement.style.background = "transparent"
    document.body.style.background = "transparent"
    document.body.style.overflow = "hidden"

    let active = true
    const load = async () => {
      try {
        const next = await fetchSnapshot()
        if (active) setSnapshot(next)
      } catch {
        if (active) setSnapshot(null)
      }
    }
    void load()
    const timer = window.setInterval(load, 4000)
    return () => {
      active = false
      window.clearInterval(timer)
      document.documentElement.style.background = rootBackground
      document.body.style.background = bodyBackground
      document.body.style.overflow = bodyOverflow
    }
  }, [])

  const provider = snapshot?.providers.find(
    (item) => item.id === snapshot.runtime.activeProviderId,
  )
  const model = snapshot?.models.find((item) => item.id === snapshot.runtime.activeModelId)
  const active = snapshot?.runtime.takeover === "active"

  function postMessage(type: string, payload?: unknown) {
    window.codexHotSwitchFloating?.send("codex-hot-switch-floating", {
      type,
      payload,
    })
  }

  return (
    <main
      className="flex h-dvh w-dvw items-center justify-center bg-transparent p-1"
      onContextMenu={(event) => {
        event.preventDefault()
        postMessage("context-menu")
      }}
    >
      <FloatingDevtoolsGuard />
      <button
        type="button"
        aria-label="打开热切换面板"
        className={cn(
          "group relative grid size-12 place-items-center rounded-full border border-white/70 bg-background/92 text-foreground shadow-lg shadow-black/20 outline-none backdrop-blur-md transition focus-visible:ring-3 focus-visible:ring-ring/50",
          dragging ? "scale-95 cursor-grabbing" : "cursor-grab hover:scale-105",
        )}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = {
            lastX: event.screenX,
            lastY: event.screenY,
            totalDx: 0,
            totalDy: 0,
          }
          setDragging(true)
          postMessage("drag-start", { x: event.screenX, y: event.screenY })
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return
          const dx = event.screenX - dragRef.current.lastX
          const dy = event.screenY - dragRef.current.lastY
          if (Math.abs(dx) + Math.abs(dy) < 2) return
          postMessage("drag-move", { dx, dy })
          dragRef.current = {
            lastX: event.screenX,
            lastY: event.screenY,
            totalDx: dragRef.current.totalDx + dx,
            totalDy: dragRef.current.totalDy + dy,
          }
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId)
          const moved =
            dragRef.current &&
            Math.abs(dragRef.current.totalDx) + Math.abs(dragRef.current.totalDy) >
              CLICK_MOVE_TOLERANCE
          setDragging(false)
          if (moved) postMessage("drag-end")
          else postMessage("toggle-panel")
          dragRef.current = null
        }}
        onPointerCancel={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId)
          dragRef.current = null
          setDragging(false)
          postMessage("drag-end")
        }}
      >
        <span
          className={cn(
            "absolute right-1 top-1 size-2.5 rounded-full border border-background",
            active ? "bg-emerald-500" : "bg-muted-foreground",
          )}
          aria-hidden
        />
        {snapshot ? (
          <Cpu className="size-5" />
        ) : (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        )}
        <span className="sr-only">
          {provider?.name ?? "未连接"} {model?.displayName ?? ""}
        </span>
      </button>
    </main>
  )
}
