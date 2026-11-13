"use client"

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"

type Theme = "light" | "dark"

interface ThemeState {
  theme: Theme
  toggle: () => void
}

const ThemeContext = createContext<ThemeState | null>(null)

const THEME_STORAGE_KEY = "codex-hotswitch-theme"
const THEME_INIT_SCRIPT = `(function(){try{var stored=localStorage.getItem("${THEME_STORAGE_KEY}");var theme=stored==="light"||stored==="dark"?stored:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");var root=document.documentElement;root.classList.toggle("dark",theme==="dark");root.style.colorScheme=theme;}catch(e){}})()`

export function ThemeProvider({ children }: { children: ReactNode }) {
  /**
   * 首帧必须与 SSR 完全一致，否则主题按钮的图标会和预渲染结果不同而触发水合错误。
   *
   * 真实主题由 layout 里的 ThemeInitScript 在 HTML 解析前就套到 <html> 上，
   * 这里在挂载后再同步到 React 状态，用户看不到闪烁。
   */
  const [theme, setTheme] = useState<Theme>("light")

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === "light" || stored === "dark") {
      setTheme(stored)
      return
    }
    setTheme(
      window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    )
  }, [])

  //首帧那一次 theme="light" 只是占位，不能把用户已存的深色偏好覆盖掉。
  const hydrated = useRef(false)

  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true
      return
    }
    const root = document.documentElement
    root.classList.toggle("dark", theme === "dark")
    root.style.colorScheme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  return (
    <ThemeContext.Provider
      value={{ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

export function ThemeInitScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内部使用")
  return ctx
}
