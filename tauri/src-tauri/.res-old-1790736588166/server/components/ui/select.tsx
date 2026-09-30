"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

interface SelectContextValue {
  value: string
  open: boolean
  labels: Map<string, string>
  contentRef: React.RefObject<HTMLDivElement | null>
  rootRef: React.RefObject<HTMLDivElement | null>
  triggerRef: React.RefObject<HTMLButtonElement | null>
  setOpen: (open: boolean) => void
  setValue: (value: string, label?: string) => void
  registerLabel: (value: string, label: string) => void
}

const SelectContext = React.createContext<SelectContextValue | null>(null)

function useSelect() {
  const ctx = React.useContext(SelectContext)
  if (!ctx) throw new Error("Select components must be used inside <Select>")
  return ctx
}

function textFromNode(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join("")
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return textFromNode(node.props.children)
  }
  return ""
}

function Select({
  value,
  defaultValue = "",
  onValueChange,
  children,
}: {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children: React.ReactNode
}) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [open, setOpen] = React.useState(false)
  const [labels, setLabels] = React.useState<Map<string, string>>(() => new Map())
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue)
  const actualValue = value ?? uncontrolledValue

  React.useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node
      const clickedRoot = rootRef.current?.contains(target)
      const clickedContent = contentRef.current?.contains(target)
      if (!clickedRoot && !clickedContent) setOpen(false)
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }

    document.addEventListener("pointerdown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const registerLabel = React.useCallback((itemValue: string, label: string) => {
    setLabels((current) => {
      if (current.get(itemValue) === label) return current
      const next = new Map(current)
      next.set(itemValue, label)
      return next
    })
  }, [])

  const setValue = React.useCallback(
    (nextValue: string) => {
      if (value == null) setUncontrolledValue(nextValue)
      onValueChange?.(nextValue)
      setOpen(false)
    },
    [onValueChange, value],
  )

  const contextValue = React.useMemo<SelectContextValue>(
    () => ({
      value: actualValue,
      open,
      labels,
      contentRef,
      rootRef,
      triggerRef,
      setOpen,
      setValue,
      registerLabel,
    }),
    [actualValue, labels, open, registerLabel, setValue],
  )

  return (
    <SelectContext.Provider value={contextValue}>
      <div ref={rootRef} data-slot="select" className="relative">
        {children}
      </div>
    </SelectContext.Provider>
  )
}

function SelectGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-group"
      className={cn("scroll-my-1 p-1", className)}
      role="group"
      {...props}
    />
  )
}

function SelectValue({
  className,
  placeholder,
  ...props
}: React.ComponentProps<"span"> & {
  placeholder?: string
}) {
  const { value, labels } = useSelect()
  const label = labels.get(value) ?? value
  return (
    <span
      data-slot="select-value"
      className={cn("flex flex-1 text-left", className)}
      {...props}
    >
      {label || placeholder || ""}
    </span>
  )
}

function SelectTrigger({
  className,
  size = "default",
  children,
  onClick,
  onKeyDown,
  ...props
}: React.ComponentProps<"button"> & {
  size?: "sm" | "default"
}) {
  const { open, setOpen, triggerRef } = useSelect()
  return (
    <button
      ref={triggerRef}
      data-slot="select-trigger"
      data-size={size}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      className={cn(
        "flex w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented) setOpen(!open)
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (event.key === "Escape") setOpen(false)
      }}
      {...props}
    >
      {children}
      <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
    </button>
  )
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger: _alignItemWithTrigger,
  style,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "top" | "right" | "bottom" | "left" | "inline-start" | "inline-end"
  sideOffset?: number
  align?: "start" | "center" | "end"
  alignOffset?: number
  alignItemWithTrigger?: boolean
}) {
  const { contentRef, open, triggerRef } = useSelect()
  const [mounted, setMounted] = React.useState(false)
  const [positioned, setPositioned] = React.useState(false)
  const [actualSide, setActualSide] = React.useState(side)
  const [floatingStyle, setFloatingStyle] = React.useState<React.CSSProperties>({
    left: 0,
    top: 0,
    minWidth: 0,
  })

  React.useEffect(() => setMounted(true), [])

  const updatePosition = React.useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const gap = 8
    const maxContentHeight = 288
    const content = contentRef.current
    const measuredWidth = Math.max(rect.width, content?.offsetWidth || rect.width)
    const measuredHeight = Math.min(
      content?.scrollHeight || maxContentHeight,
      maxContentHeight,
    )

    let left = rect.left
    if (align === "center") {
      left = rect.left + rect.width / 2 - measuredWidth / 2
    } else if (align === "end") {
      left = rect.right - measuredWidth
    }
    left += alignOffset
    left = Math.max(gap, Math.min(left, viewportWidth - measuredWidth - gap))

    let top = rect.bottom + sideOffset
    let nextSide = side
    const shouldFlipToTop =
      (side === "bottom" || side === "inline-start" || side === "inline-end") &&
      top + measuredHeight > viewportHeight - gap &&
      rect.top - sideOffset - measuredHeight > gap

    if (side === "top" || shouldFlipToTop) {
      top = rect.top - sideOffset - measuredHeight
      nextSide = "top"
    } else if (side === "right") {
      top = rect.top
      left = rect.right + sideOffset
      nextSide = "right"
    } else if (side === "left") {
      top = rect.top
      left = rect.left - sideOffset - measuredWidth
      nextSide = "left"
    }

    top = Math.max(gap, Math.min(top, viewportHeight - measuredHeight - gap))
    setActualSide(nextSide)
    setFloatingStyle({ left, top, minWidth: rect.width })
    setPositioned(true)
  }, [align, alignOffset, contentRef, side, sideOffset, triggerRef])

  React.useEffect(() => {
    if (!open) {
      setPositioned(false)
      return
    }

    updatePosition()
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [open, updatePosition])

  const content = (
    <div
      ref={contentRef}
      data-slot="select-content"
      data-side={actualSide}
      data-align={align}
      hidden={!mounted || !open}
      role="listbox"
      className={cn(
        "fixed z-[1000] max-h-72 overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10",
        className,
      )}
      style={{
        ...floatingStyle,
        visibility: open && positioned ? undefined : "hidden",
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  )

  return mounted ? createPortal(content, document.body) : content
}

function SelectLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-label"
      className={cn("px-1.5 py-1 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

function SelectItem({
  className,
  children,
  value,
  disabled,
  onClick,
  ...props
}: React.ComponentProps<"button"> & {
  value: string
}) {
  const { value: currentValue, setValue, registerLabel } = useSelect()
  const selected = currentValue === value
  const label = textFromNode(children)

  React.useEffect(() => {
    registerLabel(value, label || value)
  }, [label, registerLabel, value])

  return (
    <button
      data-slot="select-item"
      data-disabled={disabled ? "" : undefined}
      data-selected={selected ? "" : undefined}
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-left text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-selected:bg-accent data-selected:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented && !disabled) setValue(value, label)
      }}
      {...props}
    >
      <span className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
        {children}
      </span>
      {selected ? (
        <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
          <CheckIcon className="pointer-events-none" />
        </span>
      ) : null}
    </button>
  )
}

function SelectSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
      role="separator"
      {...props}
    />
  )
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-scroll-up-button"
      className={cn(
        "top-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-scroll-down-button"
      className={cn(
        "bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-popover py-1 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
}
