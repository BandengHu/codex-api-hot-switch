"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  fetchConsoleTelemetry,
  fetchConsoleSnapshot,
  fetchRequestLogs,
  fetchTokenStats,
  saveConsoleSnapshot,
} from "@/lib/console-api"
import {
  isChatModel,
  isImageGenerationModel,
} from "@/lib/model-capabilities"
import type {
  ConsoleSnapshot,
  Provider,
  Model,
  ModelMapping,
  RequestLog,
  RuntimeConfig,
  Settings,
  ReasoningEffort,
  TakeoverStatus,
} from "./types"
import { initialSnapshot } from "./mock-data"

declare global {
  interface Window {
    codexHotSwitchFloating?: {
      send: (channel: string, message: unknown) => void
      onDesktopMessage?: (callback: (message: unknown) => void) => () => void
    }
  }
}

interface ConsoleState extends ConsoleSnapshot {
  loading: boolean
  saving: boolean
  error: string | null
  refresh: () => Promise<void>
  refreshLogs: () => Promise<void>
  refreshTokenStats: () => Promise<void>
  refreshTelemetry: () => Promise<void>
  replaceSnapshot: (snapshot: ConsoleSnapshot) => void
  // providers
  addProvider: (p: Provider) => void
  addProviderWithModels: (p: Provider, models: Model[]) => void
  updateProvider: (p: Provider) => void
  deleteProvider: (id: string) => void
  // models
  addModel: (m: Model) => void
  updateModel: (m: Model) => void
  deleteModel: (id: string) => void
  // mappings
  addMapping: (m: ModelMapping) => void
  updateMapping: (m: ModelMapping) => void
  deleteMapping: (id: string) => void
  // runtime
  setRuntime: (r: Partial<RuntimeConfig>) => void
  setTakeover: (status: TakeoverStatus) => void
  applySwitch: (providerId: string, modelId: string, reasoning: ReasoningEffort) => void
  resetToDefault: () => void
  // settings
  updateSettings: (s: Partial<Settings>) => void
  // helpers
  getProvider: (id: string) => Provider | undefined
  getModel: (id: string) => Model | undefined
  modelsByProvider: (providerId: string) => Model[]
}

const ConsoleContext = createContext<ConsoleState | null>(null)

function normalizeDefault(snapshot: ConsoleSnapshot): ConsoleSnapshot {
  return {
    ...snapshot,
    logs: snapshot.logs ?? [],
    tokenStats: snapshot.tokenStats ?? [],
    providers: snapshot.providers ?? [],
    models: snapshot.models ?? [],
    mappings: snapshot.mappings ?? [],
  }
}

function mergeConfigSnapshot(prev: ConsoleSnapshot, next: ConsoleSnapshot): ConsoleSnapshot {
  return normalizeDefault({
    ...next,
    logs: prev.logs,
    tokenStats: prev.tokenStats,
  })
}

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>(
    normalizeDefault(initialSnapshot),
  )
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveVersion = useRef(0)
  const pendingSaves = useRef(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const next = await fetchConsoleSnapshot()
      setSnapshot((prev) => mergeConfigSnapshot(prev, next))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshLogs = useCallback(async () => {
    try {
      const logs = await fetchRequestLogs()
      setSnapshot((prev) => ({ ...prev, logs }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const refreshTokenStats = useCallback(async () => {
    try {
      const tokenStats = await fetchTokenStats()
      setSnapshot((prev) => ({ ...prev, tokenStats }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const refreshTelemetry = useCallback(async () => {
    try {
      const { logs, tokenStats } = await fetchConsoleTelemetry()
      setSnapshot((prev) => ({ ...prev, logs, tokenStats }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const unsubscribe = window.codexHotSwitchFloating?.onDesktopMessage?.(
      (message) => {
        if (
          message &&
          typeof message === "object" &&
          (message as { type?: unknown }).type === "console-changed"
        ) {
          void refresh()
        }
      },
    )
    window.codexHotSwitchFloating?.send("codex-hot-switch-console", {
      type: "request-desktop-state",
    })
    return () => {
      unsubscribe?.()
    }
  }, [refresh])

  const persist = useCallback(
    (updater: (prev: ConsoleSnapshot) => ConsoleSnapshot) => {
      setSnapshot((prev) => {
        const previous = prev
        const optimistic = normalizeDefault(updater(prev))
        const currentSaveVersion = saveVersion.current + 1
        saveVersion.current = currentSaveVersion
        pendingSaves.current += 1
        setSaving(true)
        void saveConsoleSnapshot(optimistic)
          .then((saved) => {
            if (currentSaveVersion === saveVersion.current) {
              setSnapshot((prev) => mergeConfigSnapshot(prev, saved))
              setError(null)
            }
          })
          .catch((err) => {
            if (currentSaveVersion === saveVersion.current) {
              setSnapshot(previous)
              setError(err instanceof Error ? err.message : String(err))
            }
          })
          .finally(() => {
            pendingSaves.current = Math.max(0, pendingSaves.current - 1)
            if (pendingSaves.current === 0) setSaving(false)
          })
        return optimistic
      })
    },
    [],
  )

  const value = useMemo<ConsoleState>(() => {
    const { providers, models, mappings, logs, runtime, settings } = snapshot
    const getProvider = (id: string) => providers.find((p) => p.id === id)
    const getModel = (id: string) => models.find((m) => m.id === id)

    return {
      ...snapshot,
      loading,
      saving,
      error,
      refresh,
      refreshLogs,
      refreshTokenStats,
      refreshTelemetry,
      replaceSnapshot: (next) =>
        setSnapshot((prev) => mergeConfigSnapshot(prev, next)),
      addProvider: (p) =>
        persist((prev) => {
          const nextProviders = p.isDefault
            ? prev.providers.map((x) => ({ ...x, isDefault: false }))
            : prev.providers
          return { ...prev, providers: [...nextProviders, p] }
        }),
      addProviderWithModels: (p, providerModels) =>
        persist((prev) => {
          const nextProviders = p.isDefault
            ? prev.providers.map((x) => ({ ...x, isDefault: false }))
            : prev.providers
          const modelIds = new Set(prev.models.map((model) => model.id))
          const normalizedModels = providerModels.map((model) => {
            let id = model.id
            while (modelIds.has(id)) {
              id = `m-${crypto.randomUUID().slice(0, 8)}`
            }
            modelIds.add(id)
            return { ...model, id, providerId: p.id }
          })
          return {
            ...prev,
            providers: [...nextProviders, p],
            models: [...prev.models, ...normalizedModels],
          }
        }),
      updateProvider: (p) =>
        persist((prev) => ({
          ...prev,
          providers: prev.providers.map((x) =>
            x.id === p.id
              ? p
              : p.isDefault
                ? { ...x, isDefault: false }
                : x,
          ),
        })),
      deleteProvider: (id) =>
        persist((prev) => {
          const removedModelIds = new Set(
            prev.models.filter((m) => m.providerId === id).map((m) => m.id),
          )
          const providersNext = prev.providers.filter((x) => x.id !== id)
          const modelsNext = prev.models.filter((m) => m.providerId !== id)
          const fallbackModel = modelsNext.find(isChatModel)
          const fallbackProvider = fallbackModel
            ? providersNext.find((provider) => provider.id === fallbackModel.providerId)
            : undefined
          const runtimeNext =
            prev.runtime.activeProviderId === id ||
            removedModelIds.has(prev.runtime.activeModelId)
              ? {
                  ...prev.runtime,
                  activeProviderId: fallbackProvider?.id ?? "",
                  activeModelId: fallbackModel?.id ?? "",
                }
              : prev.runtime
          let settingsNext = prev.settings
          if (
            prev.settings.defaultProviderId === id ||
            removedModelIds.has(prev.settings.defaultModelId)
          ) {
            settingsNext = {
              ...settingsNext,
              defaultProviderId: fallbackProvider?.id ?? "",
              defaultModelId: fallbackModel?.id ?? "",
            }
          }
          if (
            prev.settings.imageGenerationProviderId === id ||
            removedModelIds.has(prev.settings.imageGenerationModelId)
          ) {
            const imageFallback = modelsNext.find(isImageGenerationModel)
            settingsNext = {
              ...settingsNext,
              imageGenerationProviderId: imageFallback?.providerId ?? "",
              imageGenerationModelId: imageFallback?.id ?? "",
            }
          }
          if (
            prev.settings.auxiliaryProviderId === id ||
            removedModelIds.has(prev.settings.auxiliaryModelId)
          ) {
            settingsNext = {
              ...settingsNext,
              auxiliaryProviderId: fallbackProvider?.id ?? "",
              auxiliaryModelId: fallbackModel?.id ?? "",
            }
          }
          return {
            ...prev,
            providers: providersNext,
            models: modelsNext,
            mappings: prev.mappings.filter(
              (m) =>
                m.targetProviderId !== id && !removedModelIds.has(m.targetModelId),
            ),
            runtime: runtimeNext,
            settings: settingsNext,
          }
        }),
      updateModel: (m) =>
        persist((prev) => ({
          ...prev,
          models: prev.models.map((x) => (x.id === m.id ? m : x)),
        })),
      addModel: (m) =>
        persist((prev) => ({
          ...prev,
          models: [...prev.models, m],
        })),
      deleteModel: (id) =>
        persist((prev) => {
          const modelsNext = prev.models.filter((m) => m.id !== id)
          const activeFallback =
            modelsNext.find(
              (m) =>
                m.providerId === prev.runtime.activeProviderId &&
                isChatModel(m),
            ) ?? modelsNext.find(isChatModel)
          const runtimeNext =
            prev.runtime.activeModelId === id
              ? {
                  ...prev.runtime,
                  activeModelId: activeFallback?.id ?? "",
                  activeProviderId: activeFallback?.providerId ?? "",
                }
              : prev.runtime
          let settingsNext = prev.settings
          if (prev.settings.defaultModelId === id) {
            const fallback = modelsNext.find(isChatModel)
            settingsNext = {
              ...settingsNext,
              defaultModelId: fallback?.id ?? "",
              defaultProviderId: fallback?.providerId ?? "",
            }
          }
          if (prev.settings.imageGenerationModelId === id) {
            const fallback = modelsNext.find(isImageGenerationModel)
            settingsNext = {
              ...settingsNext,
              imageGenerationModelId: fallback?.id ?? "",
              imageGenerationProviderId: fallback?.providerId ?? "",
            }
          }
          if (prev.settings.auxiliaryModelId === id) {
            const fallback = modelsNext.find(isChatModel)
            settingsNext = {
              ...settingsNext,
              auxiliaryModelId: fallback?.id ?? "",
              auxiliaryProviderId: fallback?.providerId ?? "",
            }
          }
          return {
            ...prev,
            models: modelsNext,
            mappings: prev.mappings.filter((m) => m.targetModelId !== id),
            runtime: runtimeNext,
            settings: settingsNext,
          }
        }),
      addMapping: (m) =>
        persist((prev) => ({ ...prev, mappings: [...prev.mappings, m] })),
      updateMapping: (m) =>
        persist((prev) => ({
          ...prev,
          mappings: prev.mappings.map((x) => (x.id === m.id ? m : x)),
        })),
      deleteMapping: (id) =>
        persist((prev) => ({
          ...prev,
          mappings: prev.mappings.filter((x) => x.id !== id),
        })),
      setRuntime: (r) =>
        persist((prev) => ({ ...prev, runtime: { ...prev.runtime, ...r } })),
      setTakeover: (status) =>
        persist((prev) => ({
          ...prev,
          runtime: { ...prev.runtime, takeover: status },
          settings: { ...prev.settings, takeoverEnabled: status === "active" },
        })),
      applySwitch: (providerId, modelId, reasoning) =>
        persist((prev) => ({
          ...prev,
          runtime: {
            ...prev.runtime,
            activeProviderId: providerId,
            activeModelId: modelId,
            reasoning,
          },
        })),
      resetToDefault: () =>
        persist((prev) => ({
          ...prev,
          runtime: {
            ...prev.runtime,
            activeProviderId: prev.settings.defaultProviderId,
            activeModelId: prev.settings.defaultModelId,
            reasoning: prev.settings.defaultReasoning,
          },
        })),
      updateSettings: (s) =>
        persist((prev) => ({
          ...prev,
          settings: { ...prev.settings, ...s },
          runtime:
            typeof s.takeoverEnabled === "boolean"
              ? {
                  ...prev.runtime,
                  takeover: s.takeoverEnabled ? "active" : "paused",
                }
              : prev.runtime,
        })),
      getProvider,
      getModel,
      modelsByProvider: (providerId) =>
        models.filter((m) => m.providerId === providerId),
    }
  }, [
    snapshot,
    loading,
    saving,
    error,
    refresh,
    refreshLogs,
    refreshTokenStats,
    refreshTelemetry,
    persist,
  ])

  return (
    <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>
  )
}

export function useConsole() {
  const ctx = useContext(ConsoleContext)
  if (!ctx) throw new Error("useConsole 必须在 ConsoleProvider 内部使用")
  return ctx
}
