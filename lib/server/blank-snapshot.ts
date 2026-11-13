import "server-only"

import { initialSnapshot } from "@/lib/mock-data"
import type { ConsoleSnapshot } from "@/lib/types"

/**
 * 新账号的初始配置：完全不继承任何供应商、模型或密钥。
 *
 * 不能直接用 initialSnapshot：它带着示例供应商与占位 Key，
 * 对多账号部署来说等于把示例上游地址塞给新用户。
 */
export function blankSnapshot(): ConsoleSnapshot {
  const seed = initialSnapshot
  return {
    version: seed.version,
    providers: [],
    models: [],
    mappings: [],
    logs: [],
    tokenStats: [],
    endpointStates: [],
    runtime: {
      activeProviderId: "",
      activeModelId: "",
      reasoning: "auto",
      takeover: "paused",
    },
    settings: {
      ...seed.settings,
      takeoverEnabled: false,
      defaultProviderId: "",
      defaultModelId: "",
      defaultReasoning: "auto",
      auxiliaryRoutingEnabled: false,
      auxiliaryProviderId: "",
      auxiliaryModelId: "",
      auxiliaryReasoning: "auto",
      codexSubagentModelSlugs: [],
      imageGenerationProviderId: "",
      imageGenerationModelId: "",
      tokenStatsResetAt: new Date().toISOString(),
    },
  }
}
