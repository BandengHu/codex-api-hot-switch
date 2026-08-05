export interface CodexDesktopPluginCheck {
  id: "browser" | "chrome" | "computer-use"
  label: string
  enabled: boolean
  sourceExists: boolean
  requiredFilesOk: boolean
  cacheLatestOk: boolean
  cacheLatestTarget: string
  cacheLatestUsesLegacySource: boolean
}

export interface CodexDesktopPluginStatus {
  codexHome: string
  configPath: string
  activeMarketplaceSource: string
  managedMarketplaceSource: boolean
  hasManualBundledMarketplace: boolean
  activeMarketplaceSourceExists: boolean
  latestInstallPath: string
  latestInstallVersion: string
  latestInstallKind: string
  latestResourcesPath: string
  latestBundledMarketplacePath: string
  latestBundledMarketplaceExists: boolean
  chromeNativeHostsPath: string
  chromeNativeHostsExists: boolean
  chromeNativeHostOk: boolean
  chromeNativeHostMode: "v2" | "legacy"
  chromeManifestPath: string
  chromeManifestExists: boolean
  chromeManifestOk: boolean
  codexCliPath: string
  codexCliExists: boolean
  nodePath: string
  nodeExists: boolean
  nodeReplPath: string
  nodeReplExists: boolean
  plugins: CodexDesktopPluginCheck[]
  healthy: boolean
  issues: string[]
  notes: string[]
}

export interface CodexDesktopPluginRepairResult {
  status: CodexDesktopPluginStatus
  message: string
  backupDir: string
}
