export interface CodexDesktopModelWhitelistInjectionInfo {
  installed: boolean
  installedAt: string
  modelCount: number
  failures: string[]
}

export interface CodexDesktopModelWhitelistStatus {
  debugPort: number
  relayBaseUrl: string
  codexRunningWithoutCdp: boolean
  desktopProcessCount: number
  cdpReachable: boolean
  cdpError: string
  targetFound: boolean
  targetTitle: string
  targetUrl: string
  injected: boolean
  injectionInfo: CodexDesktopModelWhitelistInjectionInfo | null
  targetCount: number
  codexInstallPath: string
  codexExePath: string
  codexExeExists: boolean
  modelSourceOk: boolean
  modelSourceError: string
  modelCount: number
  modelPreview: string[]
  healthy: boolean
}

export interface CodexDesktopModelWhitelistMutationResult {
  status: CodexDesktopModelWhitelistStatus
  message: string
  launchedProcessId?: number
  closedProcessCount?: number
}
