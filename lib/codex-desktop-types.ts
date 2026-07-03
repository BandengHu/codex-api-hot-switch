export interface CodexDesktopPluginCheck {
  id: "browser" | "chrome" | "computer-use"
  label: string
  enabled: boolean
  sourceExists: boolean
  requiredFilesOk: boolean
  cacheLatestOk: boolean
}

export interface CodexDesktopPluginStatus {
  codexHome: string
  configPath: string
  stableMarketplacePath: string
  activeMarketplaceSource: string
  hasManualBundledMarketplace: boolean
  activeMarketplaceSourceExists: boolean
  activeMarketplaceUsesStableSource: boolean
  latestInstallPath: string
  latestInstallVersion: string
  latestInstallKind: string
  latestResourcesPath: string
  latestBundledMarketplacePath: string
  latestBundledMarketplaceExists: boolean
  stableMarketplaceExists: boolean
  stableMarketplaceComplete: boolean
  chromeNativeHostsPath: string
  chromeNativeHostsExists: boolean
  chromeNativeHostOk: boolean
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
