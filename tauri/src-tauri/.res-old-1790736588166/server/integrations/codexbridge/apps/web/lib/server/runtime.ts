import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type WebPaths = {
  repoRoot: string;
  stateDir: string;
  runtimeDir: string;
};

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..', '..', '..');
const stateDir = path.resolve(
  process.env.CODEXBRIDGE_WEB_STATE_DIR ?? path.join(os.homedir(), '.codexbridge'),
);
const runtimeDir = path.join(stateDir, 'runtime');
const CACHE_TTL_MS = 3_000;
const runtimeJsonCache = new Map<string, CacheEntry>();

export function getWebPaths(): WebPaths {
  return {
    repoRoot,
    stateDir,
    runtimeDir,
  };
}

export function readRuntimeJson<T>(filename: string, fallback: T): T {
  const now = Date.now();
  const cached = runtimeJsonCache.get(filename);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }

  const filePath = path.join(runtimeDir, filename);
  if (!fs.existsSync(filePath)) {
    runtimeJsonCache.set(filename, {
      expiresAt: now + CACHE_TTL_MS,
      value: fallback,
    });
    return fallback;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as T;
    runtimeJsonCache.set(filename, {
      expiresAt: now + CACHE_TTL_MS,
      value: parsed,
    });
    return parsed;
  } catch {
    runtimeJsonCache.set(filename, {
      expiresAt: now + CACHE_TTL_MS,
      value: fallback,
    });
    return fallback;
  }
}

export function clearRuntimeJsonCache(filename?: string) {
  if (filename) {
    runtimeJsonCache.delete(filename);
    return;
  }
  runtimeJsonCache.clear();
}
