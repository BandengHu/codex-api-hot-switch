import type { Model, Provider } from "@/lib/types"

export interface ProviderCloneDraft {
  provider: Provider
  models: Model[]
}

type IdFactory = () => string

function createId() {
  return crypto.randomUUID()
}

export function cloneProviderWithModels(
  source: Provider,
  sourceModels: Model[],
  newId: IdFactory = createId,
): ProviderCloneDraft {
  const providerId = newId()
  return {
    provider: {
      ...source,
      id: providerId,
      name: `${source.name}（副本）`,
      apiKey: "",
      headers: source.headers.map((header) => ({ ...header, id: newId(), value: "" })),
      isDefault: false,
      health: "healthy",
      healthMessage: undefined,
    },
    models: sourceModels.map((model) => ({
      ...model,
      id: newId(),
      providerId,
      capabilities: [...model.capabilities],
    })),
  }
}

/** View-level state when user clicks clone. */
export function openCloneSheetState(
  source: Provider,
  sourceModels: Model[],
  newId: IdFactory = createId,
) {
  return {
    editing: null,
    cloneDraft: cloneProviderWithModels(source, sourceModels, newId),
    sheetOpen: true as const,
  }
}

/** Clear clone/edit draft when the provider sheet is dismissed. */
export function dismissProviderSheetState() {
  return {
    editing: null,
    cloneDraft: null,
    sheetOpen: false as const,
  }
}

export function cloneFormCopy(modelCount: number) {
  return {
    title: "复制供应商",
    submitLabel: "创建副本",
    successToast: "供应商副本已创建",
    description: `已复制供应商与模型配置，将同时复制 ${modelCount} 个关联模型；API Key 和自定义 Header 值已清空，请重新填写。`,
  }
}
