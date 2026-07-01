export interface CodexSessionDatabaseStatus {
  path: string
  source: "sqlite-dir" | "legacy-root"
  exists: boolean
  threadCount: number
  updatedAtMs: number
}

export interface CodexSessionProviderCounts {
  sessions: Record<string, number>
  archived_sessions: Record<string, number>
}

export interface CodexSessionItem {
  id: string
  title: string
  preview: string
  cwd: string
  modelProvider: string
  model: string
  reasoningEffort: string
  archived: boolean
  hasUserEvent: boolean
  tokensUsed: number
  createdAtMs: number
  updatedAtMs: number
  recencyAtMs: number
  rolloutPath: string
  sourceDbPath: string
  sourceDbSource: "sqlite-dir" | "legacy-root"
  duplicateSourceCount: number
}

export interface CodexSessionSyncStatus {
  codexHome: string
  currentProvider: string
  configuredProviders: string[]
  databases: CodexSessionDatabaseStatus[]
  canonicalDbPath: string
  backupRoot: string
  backupCount: number
  backupBytes: number
  rolloutCounts: CodexSessionProviderCounts
  sqliteCounts: CodexSessionProviderCounts | null
  encryptedContentWarning: string | null
  lockedRolloutFiles: string[]
  totalSessions: number
  sessions: CodexSessionItem[]
}

export interface CodexSessionSyncResult {
  status: CodexSessionSyncStatus
  message: string
  targetProvider: string
  previousProvider: string
  backupDir: string | null
  changedSessionFiles: number
  sqliteRowsUpdated: number
  sqliteProviderRowsUpdated: number
  sqliteUserEventRowsUpdated: number
  sqliteCwdRowsUpdated: number
  mergedThreads: number
  deletedDuplicateThreads: number
  updatedWorkspaceRoots: number
  skippedLockedRolloutFiles: string[]
}

export interface CodexSessionDeleteResult {
  status: CodexSessionSyncStatus
  message: string
  deletedThreadIds: string[]
  deletedSqliteRows: number
  deletedRolloutFiles: number
  deletedSessionIndexRows: number
  backupDir: string | null
}

export interface CodexSessionClearBackupsResult {
  status: CodexSessionSyncStatus
  message: string
  backupRoot: string
  deletedCount: number
  freedBytes: number
}
