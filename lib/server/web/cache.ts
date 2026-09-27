type Entry<T> = {
  value: T
  expiresAt: number
  bytes: number
}

const MAX_ENTRIES = 128
const MAX_BYTES = 32 * 1024 * 1024
const searchCache = new Map<string, Entry<unknown>>()
const pageCache = new Map<string, Entry<unknown>>()

function compactCache<T>(cache: Map<string, Entry<T>>, now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0)
  while (cache.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    const first = cache.keys().next().value as string | undefined
    if (!first) break
    const entry = cache.get(first)
    cache.delete(first)
    bytes -= entry?.bytes ?? 0
  }
}

function read<T>(cache: Map<string, Entry<T>>, key: string): T | undefined {
  const entry = cache.get(key)
  if (!entry || entry.expiresAt <= Date.now()) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function write<T>(
  cache: Map<string, Entry<T>>,
  key: string,
  value: T,
  ttlMs: number,
): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
  if (bytes > MAX_BYTES) return
  cache.delete(key)
  cache.set(key, { value, expiresAt: Date.now() + ttlMs, bytes })
  compactCache(cache, Date.now())
}

export function readSearchCache<T>(key: string): T | undefined {
  return read(searchCache, key) as T | undefined
}

export function writeSearchCache<T>(key: string, value: T): void {
  write(searchCache, key, value, 5 * 60 * 1000)
}

export function readPageCache<T>(key: string): T | undefined {
  return read(pageCache, key) as T | undefined
}

export function writePageCache<T>(key: string, value: T): void {
  write(pageCache, key, value, 15 * 60 * 1000)
}

export function clearWebCaches(): void {
  searchCache.clear()
  pageCache.clear()
}
