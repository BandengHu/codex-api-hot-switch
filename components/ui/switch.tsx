"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled,
  onClick,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange"> & {
  size?: "sm" | "default"
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
}) {
  const [uncontrolledChecked, setUncontrolledChecked] =
    React.useState(defaultChecked)
  const actualChecked = checked ?? uncontrolledChecked
  const thumbOffset = size === "sm" ? "10px" : "13.6px"

  function setChecked(nextChecked: boolean) {
    if (checked == null) setUncontrolledChecked(nextChecked)
    onCheckedChange?.(nextChecked)
  }

  return (
    <button
      data-slot="switch"
      data-size={size}
      data-checked={actualChecked ? "" : undefined}
      data-unchecked={!actualChecked ? "" : undefined}
      type="button"
      role="switch"
      aria-checked={actualChecked}
      disabled={disabled}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent p-[1.2px] transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] data-[size=sm]:p-px dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-emerald-500 data-unchecked:bg-neutral-950 disabled:cursor-not-allowed disabled:opacity-50 hover:data-checked:bg-emerald-600 hover:data-unchecked:bg-neutral-900 dark:data-unchecked:bg-neutral-800",
        className,
      )}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented && !disabled) setChecked(!actualChecked)
      }}
      {...props}
    >
      <span
        data-slot="switch-thumb"
        data-size={size}
        className="pointer-events-none block rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-out data-[size=default]:size-4 data-[size=sm]:size-3"
        style={{
          transform: actualChecked ? `translateX(${thumbOffset})` : "translateX(0)",
        }}
      />
    </button>
  )
}

export { Switch }
