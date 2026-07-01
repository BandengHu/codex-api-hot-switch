export interface CodexConfigBackup {
  id: string
  createdAt: string
  note: string
  path: string
  configPath: string
  authPath: string
  hasAuth: boolean
}

export interface CodexConfigStatus {
  codexHome: string
  configPath: string
  authPath: string
  backupPath: string
  backupRootPath: string
  modelCatalogPath: string
  configExists: boolean
  authExists: boolean
  backupExists: boolean
  backups: CodexConfigBackup[]
  modelCatalogExists: boolean
  installed: boolean
  authReady: boolean
  providerId: string
  currentProvider: string
  currentModel: string
  currentBaseUrl: string
  currentModelCatalogPath: string
  targetBaseUrl: string
  targetModelCatalogPath: string
}

export interface CodexConfigMutationResult {
  status: CodexConfigStatus
  message: string
}
