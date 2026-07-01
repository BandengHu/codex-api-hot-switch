import fs from 'node:fs';
import path from 'node:path';
import { buildPermissionsSettingsUpdate, resolvePermissionsState } from '../../../../src/core/permissions_mode';
import type { ApprovalsReviewer, PermissionsMode } from '../../../../src/types/core';
import { getWebPaths, readRuntimeJson } from './runtime';

type StoredBridgeSession = {
  id: string;
  providerProfileId: string;
  codexThreadId: string;
  cwd: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
};

type StoredSessionSettings = {
  bridgeSessionId: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  permissionsMode?: PermissionsMode | null;
  accessPreset?: 'read-only' | 'default' | 'full-access' | null;
  approvalPolicy?: string | null;
  sandboxMode?: string | null;
  approvalsReviewer?: ApprovalsReviewer | null;
  locale: string | null;
  metadata: Record<string, unknown>;
  updatedAt: number;
};

type StoredThreadMetadata = {
  providerProfileId: string;
  threadId: string;
  alias: string | null;
  archivedAt?: number | null;
  pinnedAt?: number | null;
  deletedAt?: number | null;
  updatedAt: number;
};

type StoredFolderMetadata = {
  cwd: string;
  alias?: string | null;
  pinnedAt?: number | null;
  removedAt?: number | null;
  updatedAt: number;
};

type StoredPlatformBinding = {
  platform: string;
  externalScopeId: string;
  bridgeSessionId: string;
  updatedAt: number;
};

type StoredProviderProfile = {
  id: string;
  providerKind: string;
  displayName: string;
  config?: {
    defaultModel?: string | null;
    baseUrl?: string | null;
    backendBaseUrl?: string | null;
  };
  updatedAt: number;
};

type StoredCodexSessionIndexEntry = {
  id: string;
  thread_name?: string | null;
  updated_at?: string | null;
};

type StoredCodexSessionMeta = {
  id: string;
  cwd?: string | null;
};

type StoredAutomationJob = {
  id: string;
  title: string;
  platform: string;
  externalScopeId: string;
  mode: string;
  providerProfileId: string;
  bridgeSessionId: string;
  status: string;
  running: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastDeliveredAt: number | null;
  lastResultPreview: string | null;
  lastError: string | null;
  updatedAt: number;
};

type StoredAssistantRecord = {
  id: string;
  type: string;
  status: string;
  title: string;
  content: string;
  priority: string | null;
  platform: string | null;
  scopeId: string | null;
  contextThreadId: string | null;
  dueAt: number | null;
  remindAt: number | null;
  updatedAt: number;
  archivedAt?: number | null;
};

type QueryCacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type ThreadMessageCacheEntry = {
  expiresAt: number;
  messages: WebCodexThreadMessage[];
  mtimeMs: number;
  size: number;
};

const QUERY_CACHE_TTL_MS = 3_000;
let codexSessionIndexCache: QueryCacheEntry<StoredCodexSessionIndexEntry[]> | null = null;
let codexSessionMetaMapCache: QueryCacheEntry<Map<string, StoredCodexSessionMeta>> | null = null;
let codexSessionFileMapCache: QueryCacheEntry<Map<string, string>> | null = null;
const threadMessageCache = new Map<string, ThreadMessageCacheEntry>();

export function clearWebQueryCaches() {
  codexSessionIndexCache = null;
  codexSessionMetaMapCache = null;
  codexSessionFileMapCache = null;
  threadMessageCache.clear();
}

export type WebSessionSummary = {
  id: string;
  title: string;
  providerProfileId: string;
  providerDisplayName: string;
  providerKind: string;
  isCodexBacked: boolean;
  codexThreadId: string;
  cwd: string | null;
  updatedAt: number;
  updatedAtLabel: string;
  alias: string | null;
  isPinned: boolean;
  isArchived: boolean;
  bindingCount: number;
  automationCount: number;
};

export type WebAutomationSummary = {
  id: string;
  title: string;
  status: string;
  running: boolean;
  scheduleLabel: string;
  providerProfileId: string;
  bridgeSessionId: string;
  nextRunAtLabel: string;
  lastRunAtLabel: string;
  lastDeliveredAtLabel: string;
  updatedAtLabel: string;
  lastError: string | null;
  lastResultPreview: string | null;
};

export type WebAssistantRecordSummary = {
  id: string;
  type: string;
  status: string;
  title: string;
  content: string;
  priority: string | null;
  dueAtLabel: string;
  remindAtLabel: string;
  updatedAtLabel: string;
};

export type WebSessionDetail = {
  session: WebSessionSummary;
  settings: StoredSessionSettings | null;
  threadMetadata: StoredThreadMetadata | null;
  bindings: StoredPlatformBinding[];
  automations: WebAutomationSummary[];
  relatedRecords: WebAssistantRecordSummary[];
};

export type WebCodexThreadSummary = {
  threadId: string;
  title: string;
  cwd: string | null;
  folderKey: string | null;
  folderLabel: string | null;
  folderPinned: boolean;
  folderRemoved: boolean;
  updatedAt: number;
  updatedAtLabel: string;
  alias: string | null;
  isPinned: boolean;
  isArchived: boolean;
  href: string;
  linkedBridgeSessionId: string | null;
  linkedBridgeSessionCount: number;
};

export type WebCodexThreadDetail = {
  thread: WebCodexThreadSummary;
  linkedSessions: WebSessionSummary[];
  bindings: StoredPlatformBinding[];
  automations: WebAutomationSummary[];
  relatedRecords: WebAssistantRecordSummary[];
};

export type WebCodexThreadSettings = {
  bridgeSessionId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  permissionsMode: 'default-permissions' | 'auto-review' | 'full-access' | 'custom';
  accessPreset: string | null;
  approvalPolicy: string | null;
  sandboxMode: string | null;
  approvalsReviewer: 'user' | 'auto_review' | null;
  usesProfileDefaults: boolean;
};

export type WebCodexThreadModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
};

export type WebCodexThreadModelOptions = {
  bridgeSessionId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  effectiveModelId: string | null;
  effectiveModelLabel: string;
  effectiveModelDescription: string;
  effectiveModelSource: 'session' | 'profile_default' | 'provider_default' | 'provider_first' | 'unset';
  effectiveReasoningEffort: string;
  effectiveReasoningEffortSource: 'session' | 'model_default' | 'unset';
  defaultReasoningEffort: string | null;
  availableModels: WebCodexThreadModelOption[];
};

export type WebCodexThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
  failed?: boolean;
  pending?: boolean;
  processPending?: boolean;
  processText?: string | null;
  source?: 'history' | 'local' | 'stream';
};

type CodexSessionInventory = {
  metaMap: Map<string, StoredCodexSessionMeta>;
  fileMap: Map<string, string>;
};

function formatDateTime(timestamp: number | null | undefined): string {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) {
    return '未记录';
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function formatMaybeText(value: string | null | undefined, fallback = '未设置') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

function getStoredSessions() {
  return readRuntimeJson<StoredBridgeSession[]>('bridge_sessions.json', []);
}

function getStoredSessionSettings() {
  return readRuntimeJson<StoredSessionSettings[]>('session_settings.json', []);
}

function getStoredThreadMetadata() {
  return readRuntimeJson<StoredThreadMetadata[]>('thread_metadata.json', []);
}

function getStoredFolderMetadata() {
  return readRuntimeJson<StoredFolderMetadata[]>('folder_metadata.json', []);
}

function getStoredPlatformBindings() {
  return readRuntimeJson<StoredPlatformBinding[]>('platform_bindings.json', []);
}

function getStoredProviderProfiles() {
  return readRuntimeJson<StoredProviderProfile[]>('provider_profiles.json', []);
}

function getStoredCodexSessionIndex(): StoredCodexSessionIndexEntry[] {
  const now = Date.now();
  if (codexSessionIndexCache && codexSessionIndexCache.expiresAt > now) {
    return codexSessionIndexCache.value;
  }

  const filePath = path.join(process.env.HOME ?? '', '.codex', 'session_index.jsonl');
  if (!filePath || !fs.existsSync(filePath)) {
    codexSessionIndexCache = {
      expiresAt: now + QUERY_CACHE_TTL_MS,
      value: [],
    };
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as StoredCodexSessionIndexEntry];
        } catch {
          return [];
        }
      });
    codexSessionIndexCache = {
      expiresAt: now + QUERY_CACHE_TTL_MS,
      value: parsed,
    };
    return parsed;
  } catch {
    codexSessionIndexCache = {
      expiresAt: now + QUERY_CACHE_TTL_MS,
      value: [],
    };
    return [];
  }
}

function readFirstLine(filePath: string, chunkBytes = 8192, maxBytes = 262144): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    let offset = 0;
    let chunk = '';

    while (offset < maxBytes) {
      const size = Math.min(chunkBytes, maxBytes - offset);
      const buffer = Buffer.allocUnsafe(size);
      const bytesRead = fs.readSync(fd, buffer, 0, size, offset);
      if (bytesRead <= 0) {
        break;
      }
      chunk += buffer.toString('utf8', 0, bytesRead);
      const newlineIndex = chunk.indexOf('\n');
      if (newlineIndex >= 0) {
        const line = chunk.slice(0, newlineIndex).trim();
        return line || null;
      }
      offset += bytesRead;
      if (bytesRead < size) {
        break;
      }
    }

    const trimmed = chunk.trim();
    return trimmed || null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close failures
      }
    }
  }
}

function getStoredCodexSessionInventory(): CodexSessionInventory {
  const now = Date.now();
  if (
    codexSessionMetaMapCache
    && codexSessionFileMapCache
    && codexSessionMetaMapCache.expiresAt > now
    && codexSessionFileMapCache.expiresAt > now
  ) {
    return {
      metaMap: codexSessionMetaMapCache.value,
      fileMap: codexSessionFileMapCache.value,
    };
  }

  const map = new Map<string, StoredCodexSessionMeta>();
  const fileMap = new Map<string, string>();
  const codexHome = path.join(process.env.HOME ?? '', '.codex');
  if (!codexHome || !fs.existsSync(codexHome)) {
    codexSessionMetaMapCache = { expiresAt: now + QUERY_CACHE_TTL_MS, value: map };
    codexSessionFileMapCache = { expiresAt: now + QUERY_CACHE_TTL_MS, value: fileMap };
    return { metaMap: map, fileMap };
  }

  const roots = [
    path.join(codexHome, 'archived_sessions'),
    path.join(codexHome, 'sessions'),
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue;
    }

    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }

        try {
          const firstLine = readFirstLine(absolute);
          if (!firstLine) {
            continue;
          }
          const parsed = JSON.parse(firstLine) as {
            type?: string;
            payload?: StoredCodexSessionMeta;
          };
          if (parsed.type !== 'session_meta' || !parsed.payload?.id) {
            continue;
          }
          map.set(parsed.payload.id, parsed.payload);
          fileMap.set(parsed.payload.id, absolute);
        } catch {
          continue;
        }
      }
    }
  }

  codexSessionMetaMapCache = { expiresAt: now + QUERY_CACHE_TTL_MS, value: map };
  codexSessionFileMapCache = { expiresAt: now + QUERY_CACHE_TTL_MS, value: fileMap };
  return { metaMap: map, fileMap };
}

function getStoredCodexSessionMetaMap(): Map<string, StoredCodexSessionMeta> {
  return getStoredCodexSessionInventory().metaMap;
}

function getStoredCodexSessionFileMap(): Map<string, string> {
  return getStoredCodexSessionInventory().fileMap;
}

function getStoredAutomationJobs() {
  return readRuntimeJson<StoredAutomationJob[]>('automation_jobs.json', []);
}

function getStoredAssistantRecords() {
  return readRuntimeJson<StoredAssistantRecord[]>('assistant_records.json', []);
}

function summarizeAutomation(job: StoredAutomationJob): WebAutomationSummary {
  const scheduleLabel = job.title.match(/\((.+)\)$/u)?.[1] ?? job.mode;
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    running: Boolean(job.running),
    scheduleLabel,
    providerProfileId: job.providerProfileId,
    bridgeSessionId: job.bridgeSessionId,
    nextRunAtLabel: formatDateTime(job.nextRunAt),
    lastRunAtLabel: formatDateTime(job.lastRunAt),
    lastDeliveredAtLabel: formatDateTime(job.lastDeliveredAt),
    updatedAtLabel: formatDateTime(job.updatedAt),
    lastError: job.lastError,
    lastResultPreview: job.lastResultPreview,
  };
}

function summarizeAssistantRecord(record: StoredAssistantRecord): WebAssistantRecordSummary {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    title: record.title,
    content: record.content,
    priority: record.priority,
    dueAtLabel: formatDateTime(record.dueAt),
    remindAtLabel: formatDateTime(record.remindAt),
    updatedAtLabel: formatDateTime(record.updatedAt),
  };
}

function summarizeSession(
  session: StoredBridgeSession,
  providerMap: Map<string, StoredProviderProfile>,
  metadataMap: Map<string, StoredThreadMetadata>,
  bindingCountMap: Map<string, number>,
  automationCountMap: Map<string, number>,
  codexSessionIndexMap: Map<string, StoredCodexSessionIndexEntry>,
  codexSessionMetaMap: Map<string, StoredCodexSessionMeta>,
): WebSessionSummary {
  const provider = providerMap.get(session.providerProfileId);
  const metadata = metadataMap.get(`${session.providerProfileId}:${session.codexThreadId}`);
  const codexSession = codexSessionIndexMap.get(session.codexThreadId);
  const codexSessionMeta = codexSessionMetaMap.get(session.codexThreadId);
  const isCodexBacked = provider?.providerKind === 'openai-native';
  const resolvedUpdatedAt = isCodexBacked
    ? Math.max(session.updatedAt, parseMaybeDate(codexSession?.updated_at))
    : session.updatedAt;

  return {
    id: session.id,
    title: isCodexBacked
      ? formatMaybeText(codexSession?.thread_name, formatMaybeText(session.title, '未命名会话'))
      : formatMaybeText(session.title, '未命名会话'),
    providerProfileId: session.providerProfileId,
    providerDisplayName: provider?.displayName ?? session.providerProfileId,
    providerKind: provider?.providerKind ?? 'unknown',
    isCodexBacked,
    codexThreadId: session.codexThreadId,
    cwd: (isCodexBacked ? codexSessionMeta?.cwd : null) ?? session.cwd ?? null,
    updatedAt: resolvedUpdatedAt,
    updatedAtLabel: formatDateTime(resolvedUpdatedAt),
    alias: metadata?.alias ?? null,
    isPinned: Boolean(metadata?.pinnedAt),
    isArchived: Boolean(metadata?.archivedAt),
    bindingCount: bindingCountMap.get(session.id) ?? 0,
    automationCount: automationCountMap.get(session.id) ?? 0,
  };
}

function buildCodexThreadSummary(
  entry: StoredCodexSessionIndexEntry,
  meta: StoredCodexSessionMeta | null,
  metadata: StoredThreadMetadata | null,
  folderMetadata: StoredFolderMetadata | null,
  linkedSessions: WebSessionSummary[],
): WebCodexThreadSummary {
  const primaryLinkedSession = linkedSessions[0] ?? null;
  const resolvedCwd = meta?.cwd ?? primaryLinkedSession?.cwd ?? null;
  return {
    threadId: entry.id,
    title: formatMaybeText(entry.thread_name, primaryLinkedSession?.title ?? '未命名会话'),
    cwd: resolvedCwd,
    folderKey: resolvedCwd,
    folderLabel: folderMetadata?.alias?.trim() || null,
    folderPinned: typeof folderMetadata?.pinnedAt === 'number',
    folderRemoved: typeof folderMetadata?.removedAt === 'number',
    updatedAt: parseMaybeDate(entry.updated_at),
    updatedAtLabel: formatDateTime(parseMaybeDate(entry.updated_at)),
    alias: metadata?.alias ?? null,
    isPinned: Boolean(metadata?.pinnedAt),
    isArchived: Boolean(metadata?.archivedAt),
    href: `/sessions/codex/${entry.id}`,
    linkedBridgeSessionId: primaryLinkedSession?.id ?? null,
    linkedBridgeSessionCount: linkedSessions.length,
  };
}

function parseMaybeDate(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export async function listWebSessions(): Promise<WebSessionSummary[]> {
  const sessions = getStoredSessions();
  const providers = getStoredProviderProfiles();
  const threadMetadata = getStoredThreadMetadata();
  const bindings = getStoredPlatformBindings();
  const automations = getStoredAutomationJobs();
  const codexSessionIndex = getStoredCodexSessionIndex();
  const codexSessionMetaMap = getStoredCodexSessionMetaMap();

  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const metadataMap = new Map(
    threadMetadata.map((metadata) => [`${metadata.providerProfileId}:${metadata.threadId}`, metadata]),
  );
  const codexSessionIndexMap = new Map<string, StoredCodexSessionIndexEntry>();
  for (const entry of codexSessionIndex) {
    const previous = codexSessionIndexMap.get(entry.id);
    if (!previous || parseMaybeDate(entry.updated_at) >= parseMaybeDate(previous.updated_at)) {
      codexSessionIndexMap.set(entry.id, entry);
    }
  }
  const bindingCountMap = new Map<string, number>();
  const automationCountMap = new Map<string, number>();

  for (const binding of bindings) {
    bindingCountMap.set(binding.bridgeSessionId, (bindingCountMap.get(binding.bridgeSessionId) ?? 0) + 1);
  }
  for (const automation of automations) {
    automationCountMap.set(
      automation.bridgeSessionId,
      (automationCountMap.get(automation.bridgeSessionId) ?? 0) + 1,
    );
  }

  return sessions
    .slice()
    .map((session) =>
      summarizeSession(
        session,
        providerMap,
        metadataMap,
        bindingCountMap,
        automationCountMap,
        codexSessionIndexMap,
        codexSessionMetaMap,
      ),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getWebSessionDetail(sessionId: string): Promise<WebSessionDetail | null> {
  const sessions = getStoredSessions();
  const settings = getStoredSessionSettings();
  const providers = getStoredProviderProfiles();
  const threadMetadata = getStoredThreadMetadata();
  const bindings = getStoredPlatformBindings();
  const automations = getStoredAutomationJobs();
  const records = getStoredAssistantRecords();
  const codexSessionIndex = getStoredCodexSessionIndex();
  const codexSessionMetaMap = getStoredCodexSessionMetaMap();

  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session) {
    return null;
  }

  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const metadataMap = new Map(
    threadMetadata.map((metadata) => [`${metadata.providerProfileId}:${metadata.threadId}`, metadata]),
  );
  const codexSessionIndexMap = new Map<string, StoredCodexSessionIndexEntry>();
  for (const entry of codexSessionIndex) {
    const previous = codexSessionIndexMap.get(entry.id);
    if (!previous || parseMaybeDate(entry.updated_at) >= parseMaybeDate(previous.updated_at)) {
      codexSessionIndexMap.set(entry.id, entry);
    }
  }
  const bindingCountMap = new Map<string, number>();
  const automationCountMap = new Map<string, number>();
  for (const binding of bindings) {
    bindingCountMap.set(binding.bridgeSessionId, (bindingCountMap.get(binding.bridgeSessionId) ?? 0) + 1);
  }
  for (const automation of automations) {
    automationCountMap.set(
      automation.bridgeSessionId,
      (automationCountMap.get(automation.bridgeSessionId) ?? 0) + 1,
    );
  }

  const relatedBindings = bindings.filter((binding) => binding.bridgeSessionId === session.id);
  const relatedAutomations = automations
    .filter((automation) => automation.bridgeSessionId === session.id)
    .sort((left, right) => {
      const leftAt = left.nextRunAt ?? left.updatedAt ?? 0;
      const rightAt = right.nextRunAt ?? right.updatedAt ?? 0;
      return leftAt - rightAt;
    })
    .map((automation) => summarizeAutomation(automation));
  const bindingScopes = new Set(relatedBindings.map((binding) => `${binding.platform}:${binding.externalScopeId}`));
  const relatedRecords = records
    .filter((record) => {
      const scopeKey = record.platform && record.scopeId ? `${record.platform}:${record.scopeId}` : null;
      return record.contextThreadId === session.codexThreadId || (scopeKey ? bindingScopes.has(scopeKey) : false);
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 8)
    .map((record) => summarizeAssistantRecord(record));

  return {
    session: summarizeSession(
      session,
      providerMap,
      metadataMap,
      bindingCountMap,
      automationCountMap,
      codexSessionIndexMap,
      codexSessionMetaMap,
    ),
    settings: settings.find((entry) => entry.bridgeSessionId === session.id) ?? null,
    threadMetadata: metadataMap.get(`${session.providerProfileId}:${session.codexThreadId}`) ?? null,
    bindings: relatedBindings,
    automations: relatedAutomations,
    relatedRecords,
  };
}

export async function listWebCodexThreads(): Promise<WebCodexThreadSummary[]> {
  const codexSessionIndex = getStoredCodexSessionIndex();
  const codexSessionMetaMap = getStoredCodexSessionMetaMap();
  const providers = getStoredProviderProfiles();
  const threadMetadata = getStoredThreadMetadata();
  const folderMetadata = getStoredFolderMetadata();
  const defaultNativeProviderIds = new Set(
    providers.filter((provider) => provider.providerKind === 'openai-native').map((provider) => provider.id),
  );
  const metadataMap = new Map(
    threadMetadata
      .filter((metadata) => defaultNativeProviderIds.has(metadata.providerProfileId))
      .map((metadata) => [metadata.threadId, metadata]),
  );
  const folderMetadataMap = new Map(
    folderMetadata
      .filter((entry) => typeof entry.cwd === 'string' && entry.cwd.trim())
      .map((entry) => [entry.cwd.trim(), entry]),
  );

  const latestIndexMap = new Map<string, StoredCodexSessionIndexEntry>();
  for (const entry of codexSessionIndex) {
    const previous = latestIndexMap.get(entry.id);
    if (!previous || parseMaybeDate(entry.updated_at) >= parseMaybeDate(previous.updated_at)) {
      latestIndexMap.set(entry.id, entry);
    }
  }

  return Array.from(latestIndexMap.values())
    .filter((entry) => !metadataMap.get(entry.id)?.deletedAt)
    .map((entry) => ({
        entry,
        summary: buildCodexThreadSummary(
          entry,
          codexSessionMetaMap.get(entry.id) ?? null,
          metadataMap.get(entry.id) ?? null,
          folderMetadataMap.get((codexSessionMetaMap.get(entry.id)?.cwd ?? '').trim()) ?? null,
          [],
        ),
      }))
    .filter(({ summary }) => !summary.folderRemoved)
    .map(({ summary }) => summary)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getWebCodexThreadDetail(threadId: string): Promise<WebCodexThreadDetail | null> {
  const threadList = await listWebCodexThreads();
  const thread = threadList.find((entry) => entry.threadId === threadId);
  if (!thread) {
    return null;
  }

  const allSessions = await listWebSessions();
  const linkedSessions = allSessions
    .filter((session) => session.providerKind === 'openai-native' && session.codexThreadId === threadId)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const bindings = getStoredPlatformBindings().filter((binding) =>
    linkedSessions.some((session) => session.id === binding.bridgeSessionId),
  );
  const automations = listWebAutomationsSync().filter((job) =>
    linkedSessions.some((session) => session.id === job.bridgeSessionId),
  );
  const bindingScopes = new Set(bindings.map((binding) => `${binding.platform}:${binding.externalScopeId}`));
  const relatedRecords = getStoredAssistantRecords()
    .filter((record) => {
      const scopeKey = record.platform && record.scopeId ? `${record.platform}:${record.scopeId}` : null;
      return record.contextThreadId === threadId || (scopeKey ? bindingScopes.has(scopeKey) : false);
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 8)
    .map((record) => summarizeAssistantRecord(record));

  return {
    thread,
    linkedSessions,
    bindings,
    automations,
    relatedRecords,
  };
}

export async function getWebCodexThreadSettings(
  threadId: string,
): Promise<WebCodexThreadSettings | null> {
  const threadDetail = await getWebCodexThreadDetail(threadId);
  if (!threadDetail) {
    return null;
  }
  const settings = getStoredSessionSettings();
  const linkedSession = threadDetail.linkedSessions[0] ?? null;
  const linkedSettings = linkedSession
    ? settings.find((entry) => entry.bridgeSessionId === linkedSession.id) ?? null
    : null;
  const resolved = resolvePermissionsState(linkedSettings ?? buildPermissionsSettingsUpdate('default-permissions'));
  return {
    bridgeSessionId: linkedSession?.id ?? null,
    model: linkedSettings?.model ?? null,
    reasoningEffort: linkedSettings?.reasoningEffort ?? null,
    serviceTier: linkedSettings?.serviceTier ?? null,
    permissionsMode: resolved.permissionsMode,
    accessPreset: resolved.accessPreset,
    approvalPolicy: resolved.approvalPolicy,
    sandboxMode: resolved.sandboxMode,
    approvalsReviewer: resolved.approvalsReviewer,
    usesProfileDefaults: resolved.usesProfileDefaults,
  };
}

function extractMessageText(
  content:
    | Array<{ type?: string; text?: string; content?: Array<{ text?: string }> }>
    | undefined,
): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (typeof item?.text === 'string') {
        return item.text.trim();
      }
      if (Array.isArray(item?.content)) {
        return item.content
          .map((child) => (typeof child?.text === 'string' ? child.text.trim() : ''))
          .filter(Boolean)
          .join('\n\n')
          .trim();
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function isInternalCodexUserMessage(role: 'user' | 'assistant', text: string): boolean {
  if (role !== 'user') {
    return false;
  }
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }
  if (/<environment_context>/u.test(normalized)) {
    return true;
  }
  if (/<filesystem>/u.test(normalized) || /<workspace_roots>/u.test(normalized)) {
    return true;
  }
  if (/<current_date>/u.test(normalized) || /<timezone>/u.test(normalized)) {
    return true;
  }
  if (/<permission_profile/u.test(normalized)) {
    return true;
  }
  return false;
}

function parseCodexMessagesFromLines(lines: string[]): WebCodexThreadMessage[] {
  const messages: WebCodexThreadMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as {
        timestamp?: string;
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          content?: Array<{ type?: string; text?: string; content?: Array<{ text?: string }> }>;
        };
      };
      if (parsed.type !== 'response_item' || parsed.payload?.type !== 'message') {
        continue;
      }
      if (parsed.payload.role !== 'user' && parsed.payload.role !== 'assistant') {
        continue;
      }
      const text = extractMessageText(parsed.payload.content);
      if (!text || isInternalCodexUserMessage(parsed.payload.role, text)) {
        continue;
      }
      messages.push({
        id: `${parsed.timestamp ?? 'msg'}:${messages.length}`,
        role: parsed.payload.role,
        source: 'history',
        text,
        timestamp: parsed.timestamp ?? null,
      });
    } catch {
      continue;
    }
  }
  return messages;
}

function readFileTail(filePath: string, maxBytes = 1024 * 1024): string {
  const stat = fs.statSync(filePath);
  const readBytes = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - readBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, start);
    let chunk = buffer.toString('utf8');
    if (start > 0) {
      const newlineIndex = chunk.indexOf('\n');
      chunk = newlineIndex >= 0 ? chunk.slice(newlineIndex + 1) : '';
    }
    return chunk;
  } finally {
    fs.closeSync(fd);
  }
}

function getCachedThreadMessages(threadId: string, filePath: string): WebCodexThreadMessage[] {
  const stat = fs.statSync(filePath);
  const cached = threadMessageCache.get(threadId);
  const now = Date.now();
  if (
    cached
    && cached.expiresAt > now
    && cached.mtimeMs === stat.mtimeMs
    && cached.size === stat.size
  ) {
    return cached.messages;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const messages = parseCodexMessagesFromLines(raw.split('\n'));
  threadMessageCache.set(threadId, {
    expiresAt: now + QUERY_CACHE_TTL_MS,
    messages,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  return messages;
}

export async function listWebCodexThreadMessages(
  threadId: string,
  offset = 0,
  limit = 8,
): Promise<{
  items: WebCodexThreadMessage[];
  hasMore: boolean;
}> {
  const filePath = getStoredCodexSessionFileMap().get(threadId);
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      items: [],
      hasMore: false,
    };
  }

  const messages = getCachedThreadMessages(threadId, filePath);
  const end = Math.max(0, messages.length - offset);
  const start = Math.max(0, end - limit);
  const slice = messages.slice(start, end);
  return {
    items: slice,
    hasMore: start > 0,
  };
}

export async function getWebCodexThreadRecentMessages(
  threadId: string,
  limit = 8,
): Promise<{
  items: WebCodexThreadMessage[];
  hasMore: boolean;
}> {
  const filePath = getStoredCodexSessionFileMap().get(threadId);
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      items: [],
      hasMore: false,
    };
  }

  const tail = readFileTail(filePath);
  const messages = parseCodexMessagesFromLines(tail.split('\n'));
  return {
    items: messages.slice(Math.max(0, messages.length - limit)),
    hasMore: messages.length > limit,
  };
}

function listWebAutomationsSync(): WebAutomationSummary[] {
  return getStoredAutomationJobs()
    .slice()
    .sort((left, right) => {
      const leftAt = left.nextRunAt ?? left.updatedAt ?? 0;
      const rightAt = right.nextRunAt ?? right.updatedAt ?? 0;
      return leftAt - rightAt;
    })
    .map((job) => summarizeAutomation(job));
}

export async function listWebAutomations(): Promise<WebAutomationSummary[]> {
  return listWebAutomationsSync();
}

export async function getWebRuntimeStatus() {
  const paths = getWebPaths();
  const sessions = getStoredSessions();
  const providers = getStoredProviderProfiles();
  const automations = getStoredAutomationJobs();
  const records = getStoredAssistantRecords();
  const bindings = getStoredPlatformBindings();

  return {
    stateDir: paths.stateDir,
    runtimeDir: paths.runtimeDir,
    repoRoot: paths.repoRoot,
    sessionCount: sessions.length,
    activeAutomationCount: automations.filter((job) => job.status === 'active').length,
    activeRecordCount: records.filter((record) => record.status === 'active').length,
    bindingCount: bindings.length,
    defaultProviderProfileId: providers.find((provider) => provider.id === 'openai-default')?.id ?? providers[0]?.id ?? null,
    providers: providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      providerKind: provider.providerKind,
      defaultModel: provider.config?.defaultModel ?? null,
      baseUrl: provider.config?.baseUrl ?? provider.config?.backendBaseUrl ?? null,
      sessionCount: sessions.filter((session) => session.providerProfileId === provider.id).length,
    })),
  };
}
