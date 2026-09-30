"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react"

interface ResizableSheetWidthOptions {
  storageKey: string
  minWidth: number
  maxWidth: number
  defaultWidth: number
  viewportGap?: number
}

interface ResizeDragState {
  startX: number
  startWidth: number
  pointerId: number | null
  target: HTMLElement | null
}

function viewportBoundedMax(minWidth: number, maxWidth: number, viewportGap: number) {
  if (typeof window === "undefined") return maxWidth
  return Math.min(maxWidth, Math.max(minWidth, window.innerWidth - viewportGap))
}

export function useResizableSheetWidth({
  storageKey,
  minWidth,
  maxWidth,
  defaultWidth,
  viewportGap = 48,
}: ResizableSheetWidthOptions) {
  const [width, setWidth] = useState(defaultWidth)
  const [isResizing, setIsResizing] = useState(false)
  const widthRef = useRef(defaultWidth)
  const dragState = useRef<ResizeDragState | null>(null)
  const cleanupDragRef = useRef<(() => void) | null>(null)

  const clampWidth = useCallback(
    (nextWidth: number) => {
      if (!Number.isFinite(nextWidth)) return defaultWidth
      return Math.min(
        Math.max(nextWidth, minWidth),
        viewportBoundedMax(minWidth, maxWidth, viewportGap),
      )
    },
    [defaultWidth, maxWidth, minWidth, viewportGap],
  )

  const commitWidth = useCallback(
    (nextWidth: number, persist = false) => {
      const clamped = clampWidth(nextWidth)
      widthRef.current = clamped
      setWidth(clamped)
      if (persist) window.localStorage.setItem(storageKey, String(clamped))
      return clamped
    },
    [clampWidth, storageKey],
  )

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey)
    if (!stored) return
    commitWidth(Number(stored))
  }, [commitWidth, storageKey])

  useEffect(() => {
    const onResize = () => commitWidth(widthRef.current, true)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [commitWidth])

  useEffect(() => {
    return () => cleanupDragRef.current?.()
  }, [])

  const beginResize = useCallback(
    (clientX: number, target: HTMLElement | null, pointerId: number | null) => {
      cleanupDragRef.current?.()

      const root = document.documentElement
      const body = document.body
      const previousRootCursor = root.style.cursor
      const previousBodyCursor = body.style.cursor
      const previousUserSelect = body.style.userSelect
      const previousTouchAction = body.style.touchAction

      root.style.cursor = "ew-resize"
      body.style.cursor = "ew-resize"
      body.style.userSelect = "none"
      body.style.touchAction = "none"

      dragState.current = {
        startX: clientX,
        startWidth: widthRef.current,
        pointerId,
        target,
      }
      setIsResizing(true)

      if (target && pointerId != null) {
        try {
          target.setPointerCapture(pointerId)
        } catch {
          // Some embedded browser runtimes expose PointerEvent without capture support.
        }
      }

      const updateWidth = (nextClientX: number) => {
        const current = dragState.current
        if (!current) return
        commitWidth(current.startWidth + current.startX - nextClientX)
      }

      const onPointerMove = (event: PointerEvent) => {
        event.preventDefault()
        event.stopPropagation()
        updateWidth(event.clientX)
      }

      const finishResize = (event?: Event) => {
        event?.preventDefault()
        event?.stopPropagation()

        const current = dragState.current
        if (current?.target && current.pointerId != null) {
          try {
            if (current.target.hasPointerCapture(current.pointerId)) {
              current.target.releasePointerCapture(current.pointerId)
            }
          } catch {
            // Capture may already be released by the browser.
          }
        }

        window.removeEventListener("pointermove", onPointerMove, true)
        window.removeEventListener("pointerup", finishResize, true)
        window.removeEventListener("pointercancel", finishResize, true)

        root.style.cursor = previousRootCursor
        body.style.cursor = previousBodyCursor
        body.style.userSelect = previousUserSelect
        body.style.touchAction = previousTouchAction

        dragState.current = null
        cleanupDragRef.current = null
        window.localStorage.setItem(storageKey, String(widthRef.current))
        setIsResizing(false)
      }

      cleanupDragRef.current = finishResize
      window.addEventListener("pointermove", onPointerMove, {
        capture: true,
        passive: false,
      })
      window.addEventListener("pointerup", finishResize, true)
      window.addEventListener("pointercancel", finishResize, true)
    },
    [commitWidth, storageKey],
  )

  const startPointerResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      beginResize(event.clientX, event.currentTarget, event.pointerId)
    },
    [beginResize],
  )

  const adjustByKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? 80 : 24
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        commitWidth(widthRef.current + step, true)
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        commitWidth(widthRef.current - step, true)
      } else if (event.key === "Home") {
        event.preventDefault()
        commitWidth(minWidth, true)
      } else if (event.key === "End") {
        event.preventDefault()
        commitWidth(maxWidth, true)
      } else if (event.key === "Enter") {
        event.preventDefault()
        commitWidth(defaultWidth, true)
      }
    },
    [commitWidth, defaultWidth, maxWidth, minWidth],
  )

  const sheetStyle = useMemo<CSSProperties>(
    () => ({
      width: `min(calc(100vw - ${viewportGap}px), ${width}px)`,
      maxWidth: `calc(100vw - ${viewportGap}px)`,
    }),
    [viewportGap, width],
  )

  const handleProps = useMemo(
    () => ({
      "data-log-detail-resize-handle": "true",
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical" as const,
      "aria-valuemin": minWidth,
      "aria-valuemax": maxWidth,
      "aria-valuenow": Math.round(width),
      onPointerDown: startPointerResize,
      onKeyDown: adjustByKeyboard,
    }),
    [
      adjustByKeyboard,
      maxWidth,
      minWidth,
      startPointerResize,
      width,
    ],
  )

  return {
    width,
    isResizing,
    sheetStyle,
    handleProps,
  }
}
