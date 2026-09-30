export type WecomBridgeProcessState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed"
  | "external-running"

export type WecomBridgeDiagnosticState = "ok" | "warn" | "error"

export interface WecomBridgeSettings {
  stateDir: string
  cwd: string
  enabled: boolean
  botId: string
  secret: string
  corpId: string
  debug: boolean
  nativeApiEnabled: boolean
  codexRealBin: string
  providerProfileId: string
  locale: "auto" | "zh-CN" | "en"
  maxMessageLength: number
}

export interface WecomBridgeProcessStatus {
  state: WecomBridgeProcessState
  owned: boolean
  pid?: number
  startedAt?: string
  exitedAt?: string
  exitCode?: number | null
  signal?: string | null
  message?: string
  // 崩溃自动拉起累计次数（用户主动停止或正常退出时重置）。
  autoRestarts?: number
}

export interface WecomBridgeLogs {
  serveOut: string
  serveErr: string
}

export interface WecomBridgeDiagnosticItem {
  key: string
  label: string
  state: WecomBridgeDiagnosticState
  detail: string
}

export interface WecomBridgeCommandHelpItem {
  command: string
  description: string
}

export interface WecomBridgeStatus {
  available: boolean
  vendorRoot: string
  settings: WecomBridgeSettings
  serve: WecomBridgeProcessStatus
  logs: WecomBridgeLogs
  paths: {
    settingsPath: string
    serveLockPath: string
    logDir: string
  }
  commands: string[]
  diagnostics: WecomBridgeDiagnosticItem[]
  commandHelp: WecomBridgeCommandHelpItem[]
  error?: string
}

export interface WecomBridgeMutationResult {
  ok: boolean
  message: string
  status: WecomBridgeStatus
}
