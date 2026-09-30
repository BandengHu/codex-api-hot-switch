"use client"

import { useEffect } from "react"

const NEXT_DEVTOOLS_SELECTORS = [
  'script[data-nextjs-dev-overlay="true"]',
  '[data-nextjs-dev-overlay="true"]',
  "nextjs-portal",
  "[data-nextjs-toast]",
  "[data-next-mark]",
  "#nextjs-dev-tools-menu",
  "#data-devtools-indicator",
  "#panel-route",
  ".dev-tools-indicator-menu",
  ".dev-tools-indicator-inner",
  ".nextjs-toast",
  ".nextjs-toast-errors-parent",
  "[data-nextjs-devtools-panel-overlay]",
  "[data-nextjs-dialog]",
  "[data-nextjs-dialog-root]",
  "[data-nextjs-dialog-overlay]",
  "[data-nextjs-dialog-backdrop]",
  "[data-nextjs-dialog-backdrop-fixed]",
  "[data-nextjs-dialog-sizer]",
  "[data-nextjs-error-overlay-nav]",
]

function hideNextDevtoolsNodes() {
  for (const selector of NEXT_DEVTOOLS_SELECTORS) {
    document.querySelectorAll(selector).forEach((node) => {
      node.setAttribute("aria-hidden", "true")
      if (node instanceof HTMLElement) {
        node.hidden = true
        node.style.setProperty("display", "none", "important")
        node.style.setProperty("pointer-events", "none", "important")
        node.style.setProperty("visibility", "hidden", "important")
      }
    })
  }
}

export function FloatingDevtoolsGuard() {
  useEffect(() => {
    hideNextDevtoolsNodes()
    const observer = new MutationObserver(() => hideNextDevtoolsNodes())
    observer.observe(document.documentElement, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
          nextjs-portal,
          script[data-nextjs-dev-overlay="true"],
          [data-nextjs-dev-overlay="true"],
          [data-nextjs-toast],
          [data-next-mark],
          #nextjs-dev-tools-menu,
          #data-devtools-indicator,
          #panel-route,
          .dev-tools-indicator-menu,
          .dev-tools-indicator-inner,
          .nextjs-toast,
          .nextjs-toast-errors-parent,
          [data-nextjs-devtools-panel-overlay],
          [data-nextjs-dialog],
          [data-nextjs-dialog-root],
          [data-nextjs-dialog-overlay],
          [data-nextjs-dialog-backdrop],
          [data-nextjs-dialog-backdrop-fixed],
          [data-nextjs-dialog-sizer],
          [data-nextjs-error-overlay-nav] {
            display: none !important;
            pointer-events: none !important;
            visibility: hidden !important;
          }
        `,
      }}
    />
  )
}
