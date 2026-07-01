'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { usePathname } from 'next/navigation';
import { SessionSidebar } from '@/components/session-sidebar';
import { WorkspaceShell } from '@/components/workspace-shell';
import type { WebCodexThreadSummary } from '@/lib/server/queries';

const SIDEBAR_OPEN_STORAGE_KEY = 'codexbridge-web-sidebar-open';
const SIDEBAR_WIDTH_STORAGE_KEY = 'codexbridge-web-sidebar-width';
const LAST_ACTIVE_THREAD_STORAGE_KEY = 'codexbridge-web-last-active-thread-id';
const LAST_ACTIVE_CWD_STORAGE_KEY = 'codexbridge-web-last-active-cwd';
const LAST_ACTIVE_PERMISSIONS_MODE_STORAGE_KEY = 'codexbridge-web-last-active-permissions-mode';
const LAST_ACTIVE_MODEL_STORAGE_KEY = 'codexbridge-web-last-active-model';
const LAST_ACTIVE_REASONING_EFFORT_STORAGE_KEY = 'codexbridge-web-last-active-reasoning-effort';
export const PENDING_CREATED_THREAD_STORAGE_KEY = 'codexbridge-web-pending-created-thread';
const DEFAULT_SIDEBAR_WIDTH = 284;
const MIN_SIDEBAR_WIDTH = 224;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_LAUNCH_CWD = '/home/ubuntu/dev/CodexBridge';

type PermissionsMode = 'default-permissions' | 'auto-review' | 'full-access' | 'custom';

type ThreadListResponse = {
  data: WebCodexThreadSummary[];
};

type DraftThreadState = {
  cwd: string | null;
  id: string;
  model: string | null;
  permissionsMode: PermissionsMode;
  reasoningEffort: string | null;
  startedAt: number;
};

type CodexWorkspaceContextValue = {
  activeThreadId: string | null;
  closeSidebar: () => void;
  createThread: (options?: {
    cwd?: string | null;
    initialSettings?: {
      model?: string | null;
      permissionsMode?: PermissionsMode | null;
      reasoningEffort?: string | null;
    };
  }) => Promise<{
    cwd: string | null;
    threadId: string | null;
  }>;
  clearDraftThread: () => void;
  draftThread: DraftThreadState | null;
  isMobileViewport: boolean;
  preferredLaunchPermissionsMode: PermissionsMode;
  preferredLaunchCwd: string | null;
  preferredLaunchModel: string | null;
  preferredLaunchReasoningEffort: string | null;
  refreshThreads: () => Promise<void>;
  setPreferredLaunchModelSettings: (settings: {
    model?: string | null;
    reasoningEffort?: string | null;
  }) => void;
  setPreferredLaunchPermissionsMode: (mode: PermissionsMode) => void;
  setThreads: Dispatch<SetStateAction<WebCodexThreadSummary[]>>;
  sidebarOpen: boolean;
  sidebarWidth: number;
  startDraftThread: (options?: {
    cwd?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
  }) => DraftThreadState;
  threads: WebCodexThreadSummary[];
  toggleSidebar: () => void;
};

const CodexWorkspaceContext = createContext<CodexWorkspaceContextValue | null>(null);

function clampSidebarWidth(value: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value));
}

function createDraftThreadId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `draft:${uuid}`;
  }
  return `draft:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function parseActiveThreadId(pathname: string | null) {
  if (!pathname) {
    return null;
  }
  const match = pathname.match(/^\/sessions\/codex\/([^/]+)$/u);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function areThreadListsEqual(
  left: WebCodexThreadSummary[],
  right: WebCodexThreadSummary[],
) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftThread = left[index];
    const rightThread = right[index];
    if (
      leftThread.threadId !== rightThread.threadId
      || leftThread.updatedAt !== rightThread.updatedAt
      || leftThread.title !== rightThread.title
      || leftThread.isPinned !== rightThread.isPinned
      || leftThread.isArchived !== rightThread.isArchived
      || leftThread.folderKey !== rightThread.folderKey
      || leftThread.folderLabel !== rightThread.folderLabel
      || leftThread.folderPinned !== rightThread.folderPinned
      || leftThread.folderRemoved !== rightThread.folderRemoved
    ) {
      return false;
    }
  }
  return true;
}

export function CodexWorkspaceProvider({
  children,
  initialThreads,
}: {
  children: ReactNode;
  initialThreads: WebCodexThreadSummary[];
}) {
  const pathname = usePathname();
  const activeThreadId = parseActiveThreadId(pathname);
  const [threads, setThreads] = useState<WebCodexThreadSummary[]>(initialThreads);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [lastActiveThreadId, setLastActiveThreadId] = useState<string | null>(null);
  const [lastActiveCwd, setLastActiveCwd] = useState<string | null>(null);
  const [preferredLaunchPermissionsMode, setPreferredLaunchPermissionsModeState] = useState<PermissionsMode>('default-permissions');
  const [preferredLaunchModel, setPreferredLaunchModelState] = useState<string | null>(null);
  const [preferredLaunchReasoningEffort, setPreferredLaunchReasoningEffortState] = useState<string | null>(null);
  const [draftThread, setDraftThread] = useState<DraftThreadState | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(false);

  useEffect(() => {
    const savedOpen = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    if (savedOpen === '0') {
      setSidebarOpen(false);
    } else {
      setSidebarOpen(true);
    }

    const savedWidth = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    if (Number.isFinite(savedWidth) && savedWidth > 0) {
      setSidebarWidth(clampSidebarWidth(savedWidth));
    }

    const savedThreadId = window.localStorage.getItem(LAST_ACTIVE_THREAD_STORAGE_KEY)?.trim() || '';
    if (savedThreadId) {
      setLastActiveThreadId(savedThreadId);
    }

    const savedCwd = window.localStorage.getItem(LAST_ACTIVE_CWD_STORAGE_KEY)?.trim() || '';
    if (savedCwd) {
      setLastActiveCwd(savedCwd);
    }

    const savedPermissionsMode = window.localStorage.getItem(LAST_ACTIVE_PERMISSIONS_MODE_STORAGE_KEY)?.trim() || '';
    if (
      savedPermissionsMode === 'default-permissions'
      || savedPermissionsMode === 'auto-review'
      || savedPermissionsMode === 'full-access'
      || savedPermissionsMode === 'custom'
    ) {
      setPreferredLaunchPermissionsModeState(savedPermissionsMode);
    }

    const savedModel = window.localStorage.getItem(LAST_ACTIVE_MODEL_STORAGE_KEY);
    if (typeof savedModel === 'string') {
      const normalizedModel = savedModel.trim();
      setPreferredLaunchModelState(normalizedModel || null);
    }

    const savedReasoningEffort = window.localStorage.getItem(LAST_ACTIVE_REASONING_EFFORT_STORAGE_KEY);
    if (typeof savedReasoningEffort === 'string') {
      const normalizedEffort = savedReasoningEffort.trim();
      setPreferredLaunchReasoningEffortState(normalizedEffort || null);
    }

    const media = window.matchMedia('(max-width: 960px)');
    const syncViewport = () => setIsMobileViewport(media.matches);
    syncViewport();
    media.addEventListener('change', syncViewport);
    return () => media.removeEventListener('change', syncViewport);
  }, []);

  useEffect(() => {
    setThreads((current) => (areThreadListsEqual(current, initialThreads) ? current : initialThreads));
  }, [initialThreads]);

  useEffect(() => {
    if (!activeThreadId) {
      return;
    }
    const activeThread = threads.find((entry) => entry.threadId === activeThreadId);
    if (!activeThread) {
      return;
    }
    setLastActiveThreadId(activeThread.threadId);
    window.localStorage.setItem(LAST_ACTIVE_THREAD_STORAGE_KEY, activeThread.threadId);

    const nextCwd = activeThread.cwd?.trim() || '';
    if (nextCwd) {
      setLastActiveCwd(nextCwd);
      window.localStorage.setItem(LAST_ACTIVE_CWD_STORAGE_KEY, nextCwd);
    }
  }, [activeThreadId, threads]);

  useEffect(() => {
    if (pathname === '/sessions') {
      return;
    }
    setDraftThread(null);
  }, [pathname]);

  const refreshThreads = useCallback(async () => {
    try {
      const response = await fetch('/api/codex-threads', { cache: 'no-store' });
      const payload = response.ok
        ? await response.json() as ThreadListResponse
        : { data: [] };
      const nextThreads = payload.data ?? [];
      setThreads((current) => (areThreadListsEqual(current, nextThreads) ? current : nextThreads));
    } catch {
      setThreads((current) => current);
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((current) => {
      const next = !current;
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  const closeSidebar = useCallback(() => {
    if (!window.matchMedia('(max-width: 960px)').matches) {
      return;
    }
    setSidebarOpen((current) => {
      if (!current) {
        return current;
      }
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, '0');
      return false;
    });
  }, []);

  const handleSidebarWidthChange = useCallback((nextWidth: number) => {
    const clamped = clampSidebarWidth(nextWidth);
    setSidebarWidth(clamped);
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped));
  }, []);

  const preferredLaunchCwd = useMemo(() => {
    const activeThread = activeThreadId
      ? threads.find((entry) => entry.threadId === activeThreadId)
      : null;
    const activeCwd = activeThread?.cwd?.trim() || '';
    if (activeCwd) {
      return activeCwd;
    }

    const recentThread = lastActiveThreadId
      ? threads.find((entry) => entry.threadId === lastActiveThreadId)
      : null;
    const recentCwd = recentThread?.cwd?.trim() || '';
    if (recentCwd) {
      return recentCwd;
    }

    if (lastActiveCwd?.trim()) {
      return lastActiveCwd.trim();
    }

    const firstLiveCwd = threads.find((entry) => !entry.isArchived && entry.cwd?.trim())?.cwd?.trim() || '';
    if (firstLiveCwd) {
      return firstLiveCwd;
    }

    const firstKnownCwd = threads.find((entry) => entry.cwd?.trim())?.cwd?.trim() || '';
    return firstKnownCwd || DEFAULT_LAUNCH_CWD;
  }, [activeThreadId, lastActiveCwd, lastActiveThreadId, threads]);

  const startDraftThread = useCallback((options?: {
    cwd?: string | null;
    model?: string | null;
    permissionsMode?: PermissionsMode | null;
    reasoningEffort?: string | null;
  }) => {
    const nextCwd = options?.cwd?.trim() || preferredLaunchCwd || null;
    const nextModel = typeof options?.model === 'string'
      ? (options.model.trim() || null)
      : preferredLaunchModel;
    const nextPermissionsMode = options?.permissionsMode ?? preferredLaunchPermissionsMode;
    const nextReasoningEffort = typeof options?.reasoningEffort === 'string'
      ? (options.reasoningEffort.trim() || null)
      : preferredLaunchReasoningEffort;
    if (nextCwd) {
      setLastActiveCwd(nextCwd);
      window.localStorage.setItem(LAST_ACTIVE_CWD_STORAGE_KEY, nextCwd);
    }
    const draft = {
      cwd: nextCwd,
      id: createDraftThreadId(),
      model: nextModel,
      permissionsMode: nextPermissionsMode,
      reasoningEffort: nextReasoningEffort,
      startedAt: Date.now(),
    } satisfies DraftThreadState;
    setDraftThread(draft);
    return draft;
  }, [
    preferredLaunchCwd,
    preferredLaunchModel,
    preferredLaunchPermissionsMode,
    preferredLaunchReasoningEffort,
  ]);

  const clearDraftThread = useCallback(() => {
    setDraftThread(null);
  }, []);

  const setPreferredLaunchPermissionsMode = useCallback((mode: PermissionsMode) => {
    setPreferredLaunchPermissionsModeState(mode);
    window.localStorage.setItem(LAST_ACTIVE_PERMISSIONS_MODE_STORAGE_KEY, mode);
    setDraftThread((current) => current ? { ...current, permissionsMode: mode } : current);
  }, []);

  const setPreferredLaunchModelSettings = useCallback((settings: {
    model?: string | null;
    reasoningEffort?: string | null;
  }) => {
    if (Object.prototype.hasOwnProperty.call(settings, 'model')) {
      const nextModel = typeof settings.model === 'string' ? (settings.model.trim() || null) : null;
      setPreferredLaunchModelState(nextModel);
      if (nextModel) {
        window.localStorage.setItem(LAST_ACTIVE_MODEL_STORAGE_KEY, nextModel);
      } else {
        window.localStorage.removeItem(LAST_ACTIVE_MODEL_STORAGE_KEY);
      }
      setDraftThread((current) => current ? { ...current, model: nextModel } : current);
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'reasoningEffort')) {
      const nextReasoningEffort = typeof settings.reasoningEffort === 'string'
        ? (settings.reasoningEffort.trim() || null)
        : null;
      setPreferredLaunchReasoningEffortState(nextReasoningEffort);
      if (nextReasoningEffort) {
        window.localStorage.setItem(LAST_ACTIVE_REASONING_EFFORT_STORAGE_KEY, nextReasoningEffort);
      } else {
        window.localStorage.removeItem(LAST_ACTIVE_REASONING_EFFORT_STORAGE_KEY);
      }
      setDraftThread((current) => current ? { ...current, reasoningEffort: nextReasoningEffort } : current);
    }
  }, []);

  const createThread = useCallback(async (options?: {
    cwd?: string | null;
    initialSettings?: {
      model?: string | null;
      permissionsMode?: PermissionsMode | null;
      reasoningEffort?: string | null;
    };
  }) => {
    const cwd = options?.cwd?.trim() || preferredLaunchCwd || '';
    const model = typeof options?.initialSettings?.model === 'string'
      ? options.initialSettings.model.trim()
      : '';
    const reasoningEffort = typeof options?.initialSettings?.reasoningEffort === 'string'
      ? options.initialSettings.reasoningEffort.trim()
      : '';
    const response = await fetch('/api/codex-folders/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cwd,
        model: model || null,
        permissionsMode: options?.initialSettings?.permissionsMode ?? null,
        reasoningEffort: reasoningEffort || null,
      }),
    });
    const payload = await response.json().catch(() => null) as {
      ok?: boolean;
      cwd?: string | null;
      error?: string;
      threadId?: string;
    } | null;
    if (!response.ok || !payload?.ok || !payload.threadId) {
      throw new Error((payload?.error && String(payload.error).trim()) || '创建会话失败');
    }

    const nextCwd = payload.cwd?.trim() || cwd || null;
    const optimisticThreadTitle = '新聊天';
    const optimisticFolderLabel = nextCwd
      ? nextCwd.replace(/\/+$/u, '').split('/').filter(Boolean).at(-1) || nextCwd
      : '未归类';
    if (nextCwd) {
      setLastActiveCwd(nextCwd);
      window.localStorage.setItem(LAST_ACTIVE_CWD_STORAGE_KEY, nextCwd);
    }
    setLastActiveThreadId(payload.threadId);
    window.localStorage.setItem(LAST_ACTIVE_THREAD_STORAGE_KEY, payload.threadId);
    window.sessionStorage.setItem(PENDING_CREATED_THREAD_STORAGE_KEY, JSON.stringify({
      cwd: nextCwd,
      threadId: payload.threadId,
      title: optimisticThreadTitle,
      updatedAtLabel: '刚刚',
    }));
    setThreads((current) => {
      if (current.some((entry) => entry.threadId === payload.threadId)) {
        return current;
      }
      return [
        {
          alias: null,
          cwd: nextCwd,
          folderKey: nextCwd,
          folderLabel: optimisticFolderLabel,
          folderPinned: false,
          folderRemoved: false,
          href: `/sessions/codex/${encodeURIComponent(payload.threadId)}`,
          isArchived: false,
          isPinned: false,
          linkedBridgeSessionCount: 1,
          linkedBridgeSessionId: null,
          threadId: payload.threadId,
          title: optimisticThreadTitle,
          updatedAt: Date.now(),
          updatedAtLabel: '刚刚',
        },
        ...current,
      ];
    });
    void refreshThreads();
    return {
      cwd: nextCwd,
      threadId: payload.threadId,
    };
  }, [preferredLaunchCwd, refreshThreads]);

  const value = useMemo<CodexWorkspaceContextValue>(() => ({
    activeThreadId,
    closeSidebar,
    createThread,
    clearDraftThread,
    draftThread,
    isMobileViewport,
    preferredLaunchPermissionsMode,
    preferredLaunchCwd,
    preferredLaunchModel,
    preferredLaunchReasoningEffort,
    refreshThreads,
    setPreferredLaunchModelSettings,
    setPreferredLaunchPermissionsMode,
    setThreads,
    sidebarOpen,
    sidebarWidth,
    startDraftThread,
    threads,
    toggleSidebar,
  }), [
    activeThreadId,
    closeSidebar,
    clearDraftThread,
    createThread,
    draftThread,
    isMobileViewport,
    preferredLaunchPermissionsMode,
    preferredLaunchCwd,
    preferredLaunchModel,
    preferredLaunchReasoningEffort,
    refreshThreads,
    setPreferredLaunchModelSettings,
    setPreferredLaunchPermissionsMode,
    sidebarOpen,
    sidebarWidth,
    startDraftThread,
    threads,
    toggleSidebar,
  ]);

  return (
    <CodexWorkspaceContext.Provider value={value}>
      <WorkspaceShell
        onSidebarWidthChange={handleSidebarWidthChange}
        sidebar={(
          <SessionSidebar
            activeThreadId={activeThreadId}
            onCloseSidebar={closeSidebar}
            onToggleSidebar={toggleSidebar}
            onThreadsChanged={refreshThreads}
            preferredLaunchCwd={preferredLaunchCwd}
            sessions={threads}
            onStartDraftThread={startDraftThread}
            setThreads={setThreads}
          />
        )}
        sidebarOpen={sidebarOpen}
        sidebarWidth={sidebarWidth}
      >
        {children}
      </WorkspaceShell>
    </CodexWorkspaceContext.Provider>
  );
}

export function useCodexWorkspace() {
  const context = useContext(CodexWorkspaceContext);
  if (!context) {
    throw new Error('useCodexWorkspace must be used within CodexWorkspaceProvider');
  }
  return context;
}
