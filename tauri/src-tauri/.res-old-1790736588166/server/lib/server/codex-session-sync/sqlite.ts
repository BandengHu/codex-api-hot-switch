import "server-only"

type DatabaseModule = typeof import("better-sqlite3")
type BetterSqliteDatabase = import("better-sqlite3").Database

type SqliteDatabase = {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes?: number }
  }
  exec(sql: string): void
  close(): void
}

let databaseFactoryPromise:
  | Promise<(dbPath: string, options?: { readOnly?: boolean }) => SqliteDatabase>
  | null = null

function normalizeImportDefault<T>(moduleNamespace: T & { default?: T }) {
  return moduleNamespace.default ?? moduleNamespace
}

async function loadDatabaseFactory() {
  try {
    const sqlite = (await import("node:sqlite")) as unknown as {
      DatabaseSync?: new (
        path: string,
        options?: { readOnly?: boolean },
      ) => SqliteDatabase
    }
    if (sqlite.DatabaseSync) {
      return (dbPath: string, options?: { readOnly?: boolean }) =>
        new sqlite.DatabaseSync!(dbPath, options)
    }
  } catch {
    // Node 20 does not ship node:sqlite.
  }

  const betterSqlite3 = normalizeImportDefault(
    (await import("better-sqlite3")) as unknown as DatabaseModule & {
      default?: DatabaseModule
    },
  ) as unknown as new (
    path: string,
    options?: { readonly?: boolean },
  ) => BetterSqliteDatabase
  return (dbPath: string, options?: { readOnly?: boolean }) =>
    new betterSqlite3(dbPath, { readonly: Boolean(options?.readOnly) }) as SqliteDatabase
}

async function getDatabaseFactory() {
  databaseFactoryPromise ??= loadDatabaseFactory()
  return databaseFactoryPromise
}

export async function openDatabase(
  dbPath: string,
  options: { readOnly?: boolean } = {},
) {
  const createDatabase = await getDatabaseFactory()
  return createDatabase(dbPath, options)
}

export type { SqliteDatabase }
