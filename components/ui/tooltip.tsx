"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface TooltipContextValue {
  open: boolean
  setOpen: (open: boolean) => void
}

const TooltipContext = React.createContext<TooltipContextValue | null>(null)

function useTooltip() {
  const ctx = React.useContext(TooltipContext)
  if (!ctx) throw new Error("Tooltip components must be used inside <Tooltip>")
  return ctx
}

function TooltipProvider({
  children,
}: {
  delay?: number
  children: React.ReactNode
}) {
  return children
}

function Tooltip({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  return (
    <TooltipContext.Provider value={{ open, setOpen }}>
      <span data-slot="tooltip" className="relative inline-flex">
        {children}
      </span>
    </TooltipContext.Provider>
  )
}

function TooltipTrigger({
  render,
  children,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  ...props
}: React.ComponentProps<"span"> & {
  render?: React.ReactElement<React.HTMLAttributes<HTMLElement>>
}) {
  const { setOpen } = useTooltip()
  const triggerProps = {
    ...props,
    "data-slot": "tooltip-trigger",
    tabIndex: props.tabIndex ?? 0,
    onMouseEnter: (event) => {
      onMouseEnter?.(event as React.MouseEvent<HTMLSpanElement>)
      if (!event.defaultPrevented) setOpen(true)
    },
    onMouseLeave: (event) => {
      onMouseLeave?.(event as React.MouseEvent<HTMLSpanElement>)
      if (!event.defaultPrevented) setOpen(false)
    },
    onFocus: (event) => {
      onFocus?.(event as React.FocusEvent<HTMLSpanElement>)
      if (!event.defaultPrevented) setOpen(true)
    },
    onBlur: (event) => {
      onBlur?.(event as React.FocusEvent<HTMLSpanElement>)
      if (!event.defaultPrevented) setOpen(false)
    },
  } as React.HTMLAttributes<HTMLElement> & { "data-slot": string }

  if (render && React.isValidElement(render)) {
    return React.cloneElement(render, {
      ...triggerProps,
      className: cn(render.props.className, props.className),
    })
  }

  return <span {...triggerProps}>{children}</span>
}

function TooltipContent({
  className,
  side = "top",
  children,
  ...props
}: React.ComponentProps<"span"> & {
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
  align?: "start" | "center" | "end"
  alignOffset?: number
}) {
  const { open } = useTooltip()
  if (!open) return null

  return (
    <span
      data-slot="tooltip-content"
      data-side={side}
      className={cn(
        "absolute z-50 inline-flex w-max max-w-xs items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md data-[side=bottom]:top-[calc(100%+0.5rem)] data-[side=left]:right-[calc(100%+0.5rem)] data-[side=right]:left-[calc(100%+0.5rem)] data-[side=top]:bottom-[calc(100%+0.5rem)] left-1/2 -translate-x-1/2",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
