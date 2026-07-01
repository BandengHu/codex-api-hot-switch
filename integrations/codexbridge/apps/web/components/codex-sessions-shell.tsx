'use client';

import type { FormEvent } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CodexThreadMessages } from '@/components/codex-thread-messages';
import { PENDING_CREATED_THREAD_STORAGE_KEY, useCodexWorkspace } from '@/components/codex-workspace-context';
import type {
  WebCodexThreadMessage,
  WebCodexThreadModelOptions,
  WebCodexThreadSettings,
  WebCodexThreadSummary,
} from '@/lib/server/queries';

type CodexThreadPaneProps = {
  initialThreadHasMore: boolean;
  initialThreadMessages: WebCodexThreadMessage[];
  initialThreadSettings: WebCodexThreadSettings | null;
  initialThreadSummary: WebCodexThreadSummary | null;
  threadId: string;
};

type ThreadReplyResponse = {
  ok?: boolean;
  runId?: string;
  threadId?: string;
  error?: string;
};

type ReplyRunSnapshot = {
  runId: string;
  sourceThreadId: string;
  finalThreadId: string | null;
  bridgeSessionId: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  assistantText: string;
  commentaryText: string;
  error: string | null;
  turnId: string | null;
  items: WebCodexThreadMessage[] | null;
  hasMore: boolean;
};

type PermissionsMode = NonNullable<WebCodexThreadSettings['permissionsMode']>;
type ThreadModelOptions = WebCodexThreadModelOptions;
const PENDING_THREAD_DRAFT_STORAGE_KEY = 'codexbridge-web-pending-thread-draft';

const PERMISSIONS_OPTIONS: Array<{
  mode: PermissionsMode;
  label: string;
  description: string;
}> = [
  {
    mode: 'default-permissions',
    label: '请求批准',
    description: '工作区可写，越界时请求批准',
  },
  {
    mode: 'auto-review',
    label: '替我审批',
    description: '工作区可写，由审查代理处理合格审批',
  },
  {
    mode: 'full-access',
    label: '完全访问',
    description: '不受沙箱限制',
  },
  {
    mode: 'custom',
    label: '自定义',
    description: '使用本地 config.toml 配置',
  },
];

function formatPermissionsModeLabel(mode: PermissionsMode) {
  return PERMISSIONS_OPTIONS.find((option) => option.mode === mode)?.label ?? '请求批准';
}

function formatModelPillLabel(
  modelOptions: ThreadModelOptions | null,
  initialSettings: WebCodexThreadSettings | null,
) {
  const modelLabel = modelOptions?.effectiveModelLabel
    ?? initialSettings?.model
    ?? '默认模型';
  const effortLabel = modelOptions?.effectiveReasoningEffort
    ?? initialSettings?.reasoningEffort
    ?? '默认';
  return `${modelLabel} · ${effortLabel}`;
}

function formatLaunchModelPillLabel(
  modelOptions: ThreadModelOptions | null,
  settings: {
    model: string | null;
    reasoningEffort: string | null;
  },
) {
  const modelLabel = modelOptions?.effectiveModelLabel
    ?? settings.model
    ?? '默认模型';
  const effortLabel = modelOptions?.effectiveReasoningEffort
    ?? settings.reasoningEffort
    ?? '默认';
  return `${modelLabel} · ${effortLabel}`;
}

function createLocalMessageId(prefix: 'local-user' | 'local-assistant') {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `${prefix}:${uuid}`;
  }
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function rememberPendingThreadDraft(threadId: string, text: string) {
  if (!threadId || !text.trim()) {
    return;
  }
  window.sessionStorage.setItem(PENDING_THREAD_DRAFT_STORAGE_KEY, JSON.stringify({
    text,
    threadId,
  }));
}

function takePendingThreadDraft(threadId: string) {
  const raw = window.sessionStorage.getItem(PENDING_THREAD_DRAFT_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { text?: string; threadId?: string };
    if (parsed.threadId !== threadId || typeof parsed.text !== 'string' || !parsed.text.trim()) {
      return null;
    }
    window.sessionStorage.removeItem(PENDING_THREAD_DRAFT_STORAGE_KEY);
    return parsed.text.trim();
  } catch {
    window.sessionStorage.removeItem(PENDING_THREAD_DRAFT_STORAGE_KEY);
    return null;
  }
}

function getCwdDisplayName(cwd: string | null) {
  if (!cwd) {
    return '默认位置';
  }
  const normalized = cwd.replace(/\/+$/u, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function getPendingCreatedThread(threadId: string): WebCodexThreadSummary | null {
  const raw = window.sessionStorage.getItem(PENDING_CREATED_THREAD_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      cwd?: string | null;
      threadId?: string;
      title?: string | null;
      updatedAtLabel?: string | null;
    };
    if (parsed.threadId !== threadId) {
      return null;
    }
    const cwd = typeof parsed.cwd === 'string' ? parsed.cwd.trim() : null;
    return {
      alias: null,
      cwd,
      folderKey: cwd,
      folderLabel: cwd ? getCwdDisplayName(cwd) : null,
      folderPinned: false,
      folderRemoved: false,
      href: `/sessions/codex/${threadId}`,
      isArchived: false,
      isPinned: false,
      linkedBridgeSessionCount: 1,
      linkedBridgeSessionId: null,
      threadId,
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : '新聊天',
      updatedAt: Date.now(),
      updatedAtLabel: typeof parsed.updatedAtLabel === 'string' && parsed.updatedAtLabel.trim() ? parsed.updatedAtLabel.trim() : '刚刚',
    };
  } catch {
    return null;
  }
}

function buildStreamAssistantMessage(
  draftId: string,
  timestamp: string,
  assistantText: string,
  commentaryText: string,
  status: ReplyRunSnapshot['status'],
): WebCodexThreadMessage {
  const processText = commentaryText.trim() || null;
  return {
    id: draftId,
    role: 'assistant',
    pending: status === 'queued' || status === 'running',
    processPending: (status === 'queued' || status === 'running') && Boolean(processText),
    processText,
    source: 'stream',
    text: assistantText,
    timestamp,
  };
}

function attachProcessToFinalAssistantMessages(
  items: WebCodexThreadMessage[],
  commentaryText: string,
): WebCodexThreadMessage[] {
  const processText = commentaryText.trim() || null;
  if (!processText) {
    return items;
  }
  const lastAssistantIndex = [...items]
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === 'assistant')
    .map(({ index }) => index)
    .at(-1);
  if (typeof lastAssistantIndex !== 'number') {
    return items;
  }
  return items.map((message, index) => (
    index === lastAssistantIndex
      ? {
          ...message,
          processPending: false,
          processText,
        }
      : message
  ));
}

export function CodexSessionsEmptyState() {
  const router = useRouter();
  const {
    clearDraftThread,
    createThread,
    draftThread,
    isMobileViewport,
    preferredLaunchModel,
    preferredLaunchPermissionsMode,
    preferredLaunchCwd,
    preferredLaunchReasoningEffort,
    sidebarOpen,
    setPreferredLaunchModelSettings,
    setPreferredLaunchPermissionsMode,
    threads,
    toggleSidebar,
  } = useCodexWorkspace();
  const [composerText, setComposerText] = useState('');
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [permissionsMenuOpen, setPermissionsMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [launchModelOptions, setLaunchModelOptions] = useState<ThreadModelOptions | null>(null);
  const [loadingLaunchModelOptions, setLoadingLaunchModelOptions] = useState(false);
  const [updatingLaunchModelSettings, setUpdatingLaunchModelSettings] = useState(false);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const permissionsMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const isComposing = launching || composerFocused || composerText.trim().length > 0;
  const launchCwd = draftThread?.cwd ?? preferredLaunchCwd;
  const launchModel = draftThread?.model ?? preferredLaunchModel;
  const launchPermissionsMode = draftThread?.permissionsMode ?? preferredLaunchPermissionsMode;
  const launchReasoningEffort = draftThread?.reasoningEffort ?? preferredLaunchReasoningEffort;
  const launchModelPillLabel = formatLaunchModelPillLabel(launchModelOptions, {
    model: launchModel,
    reasoningEffort: launchReasoningEffort,
  });

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) {
      return;
    }
    input.style.height = '24px';
    const maxHeight = Math.max(96, Math.round(window.innerHeight * 0.25));
    const nextHeight = Math.max(24, Math.min(input.scrollHeight, maxHeight));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [composerText]);

  useEffect(() => {
    function handlePointer(event: MouseEvent) {
      if (
        permissionsMenuRef.current
        && event.target instanceof Node
        && !permissionsMenuRef.current.contains(event.target)
      ) {
        setPermissionsMenuOpen(false);
      }
      if (
        modelMenuRef.current
        && event.target instanceof Node
        && !modelMenuRef.current.contains(event.target)
      ) {
        setModelMenuOpen(false);
      }
    }
    if (!permissionsMenuOpen && !modelMenuOpen) {
      return;
    }
    window.addEventListener('mousedown', handlePointer);
    return () => window.removeEventListener('mousedown', handlePointer);
  }, [modelMenuOpen, permissionsMenuOpen]);

  async function loadLaunchModelOptions(nextSettings?: {
    model?: string | null;
    reasoningEffort?: string | null;
  }) {
    if (loadingLaunchModelOptions && !nextSettings) {
      return;
    }
    setLoadingLaunchModelOptions(true);
    try {
      const searchParams = new URLSearchParams();
      const nextModel = typeof nextSettings?.model === 'string' ? nextSettings.model : launchModel;
      const nextEffort = typeof nextSettings?.reasoningEffort === 'string'
        ? nextSettings.reasoningEffort
        : launchReasoningEffort;
      if (nextModel) {
        searchParams.set('model', nextModel);
      }
      if (nextEffort) {
        searchParams.set('reasoningEffort', nextEffort);
      }
      const query = searchParams.toString();
      const response = await fetch(`/api/codex-launch/model-options${query ? `?${query}` : ''}`, {
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null) as (ThreadModelOptions & { error?: string }) | null;
      if (!response.ok || payload?.error) {
        throw new Error((payload?.error && String(payload.error).trim()) || '模型列表加载失败');
      }
      setLaunchModelOptions(payload);
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : '模型列表加载失败');
    } finally {
      setLoadingLaunchModelOptions(false);
    }
  }

  async function applyLaunchModelUpdate(nextSettings: {
    model?: string | null;
    reasoningEffort?: string | null;
  }) {
    setUpdatingLaunchModelSettings(true);
    setLaunchError(null);
    try {
      const normalizedSettings = { ...nextSettings };
      if (
        Object.prototype.hasOwnProperty.call(nextSettings, 'model')
        && !Object.prototype.hasOwnProperty.call(nextSettings, 'reasoningEffort')
      ) {
        const nextModel = typeof nextSettings.model === 'string' ? nextSettings.model.trim() : '';
        const nextModelOption = nextModel
          ? launchModelOptions?.availableModels.find((option) => option.model === nextModel || option.id === nextModel) ?? null
          : null;
        const currentEffort = launchReasoningEffort?.trim() || '';
        if (
          currentEffort
          && nextModelOption
          && !nextModelOption.supportedReasoningEfforts.some((effort) => effort === currentEffort)
        ) {
          normalizedSettings.reasoningEffort = null;
        }
      }

      setPreferredLaunchModelSettings(normalizedSettings);
      await loadLaunchModelOptions(normalizedSettings);
      setModelMenuOpen(false);
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : '模型设置更新失败');
    } finally {
      setUpdatingLaunchModelSettings(false);
    }
  }

  async function handleStartConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (launching) {
      return;
    }
    const text = composerText.trim();
    if (!text) {
      composerInputRef.current?.focus();
      return;
    }

    setLaunching(true);
    setLaunchError(null);
    try {
      const result = await createThread({
        cwd: launchCwd,
        initialSettings: {
          model: launchModel,
          permissionsMode: launchPermissionsMode,
          reasoningEffort: launchReasoningEffort,
        },
      });
      if (!result.threadId) {
        throw new Error('创建会话失败');
      }
      rememberPendingThreadDraft(result.threadId, text);
      setComposerText('');
      clearDraftThread();
      if (isMobileViewport && sidebarOpen) {
        toggleSidebar();
      }
      router.push(`/sessions/codex/${encodeURIComponent(result.threadId)}`, { scroll: false });
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : '创建会话失败');
      setLaunching(false);
    }
  }

  const composer = (
    <form
      className="workspace-composer-shell workspace-composer-shell-live workspace-composer-form"
      onSubmit={handleStartConversation}
    >
      <button className="workspace-composer-leading" disabled={launching} type="button">
        ＋
      </button>
      <textarea
        className="workspace-composer-input"
        onBlur={() => setComposerFocused(false)}
        onChange={(event) => setComposerText(event.target.value)}
        onFocus={() => setComposerFocused(true)}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
            keyEvent.preventDefault();
            keyEvent.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="输入你的第一条消息，将在最近目录下创建新聊天"
        ref={composerInputRef}
        rows={1}
        value={composerText}
      />
      <div className="workspace-composer-controls">
        <div className="workspace-composer-mode" ref={permissionsMenuRef}>
          <button
            aria-expanded={permissionsMenuOpen}
            aria-label="切换权限模式"
            className="workspace-composer-mode-trigger"
            disabled={launching}
            onClick={() => setPermissionsMenuOpen((current) => !current)}
            type="button"
          >
            <span>{formatPermissionsModeLabel(launchPermissionsMode)}</span>
            <span className="workspace-composer-mode-caret">⌄</span>
          </button>
          {permissionsMenuOpen ? (
            <div className="workspace-composer-mode-menu">
              {PERMISSIONS_OPTIONS.map((option) => (
                <button
                  className="workspace-composer-mode-item"
                  disabled={launching}
                  key={option.mode}
                  onClick={() => {
                    setPreferredLaunchPermissionsMode(option.mode);
                    setPermissionsMenuOpen(false);
                  }}
                  type="button"
                >
                  <span className="workspace-composer-mode-item-label">
                    {option.label}
                    {launchPermissionsMode === option.mode ? ' · 当前' : ''}
                  </span>
                  <span className="workspace-composer-mode-item-description">{option.description}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="workspace-composer-mode" ref={modelMenuRef}>
          <button
            aria-expanded={modelMenuOpen}
            aria-label="切换模型"
            className="workspace-composer-mode-trigger"
            disabled={loadingLaunchModelOptions || updatingLaunchModelSettings || launching}
            onClick={() => {
              setModelMenuOpen((current) => {
                const next = !current;
                if (next) {
                  void loadLaunchModelOptions();
                }
                return next;
              });
            }}
            type="button"
          >
            <span>{launchModelPillLabel}</span>
            <span className="workspace-composer-mode-caret">⌄</span>
          </button>
          {modelMenuOpen ? (
            <div className="workspace-composer-mode-menu">
              <button
                className="workspace-composer-mode-item"
                disabled={updatingLaunchModelSettings}
                onClick={() => void applyLaunchModelUpdate({ model: null, reasoningEffort: null })}
                type="button"
              >
                <span className="workspace-composer-mode-item-label">使用默认模型</span>
                <span className="workspace-composer-mode-item-description">清除新会话的模型与思考深度覆盖</span>
              </button>
              {loadingLaunchModelOptions && !launchModelOptions ? (
                <div className="workspace-composer-mode-item workspace-composer-mode-item-static">
                  <span className="workspace-composer-mode-item-label">正在加载模型…</span>
                </div>
              ) : null}
              {!loadingLaunchModelOptions && launchModelOptions && launchModelOptions.availableModels.length === 0 ? (
                <div className="workspace-composer-mode-item workspace-composer-mode-item-static">
                  <span className="workspace-composer-mode-item-label">当前 provider 没有返回可用模型</span>
                </div>
              ) : null}
              {launchModelOptions?.availableModels.map((option) => (
                <button
                  className="workspace-composer-mode-item"
                  disabled={updatingLaunchModelSettings}
                  key={option.id || option.model}
                  onClick={() => void applyLaunchModelUpdate({ model: option.model })}
                  type="button"
                >
                  <span className="workspace-composer-mode-item-label">
                    {option.model}
                    {launchModelOptions.effectiveModelId === option.model || launchModelOptions.effectiveModelId === option.id ? ' · 当前' : ''}
                    {option.isDefault ? ' · 默认' : ''}
                  </span>
                  <span className="workspace-composer-mode-item-description">
                    {option.displayName && option.displayName !== option.model
                      ? `${option.displayName}${option.description ? ` · ${option.description}` : ''}`
                      : (option.description || '选择这个模型用于新会话')}
                  </span>
                </button>
              ))}
              {(launchModelOptions?.availableModels.find((entry) => (
                entry.model === launchModelOptions.effectiveModelId || entry.id === launchModelOptions.effectiveModelId
              ))?.supportedReasoningEfforts ?? []).length > 0 ? (
                <>
                  <div className="workspace-composer-mode-divider" />
                  <button
                    className="workspace-composer-mode-item"
                    disabled={updatingLaunchModelSettings}
                    onClick={() => void applyLaunchModelUpdate({ reasoningEffort: null })}
                    type="button"
                  >
                    <span className="workspace-composer-mode-item-label">
                      默认思考深度
                      {launchModelOptions?.effectiveReasoningEffortSource === 'model_default' ? ' · 当前' : ''}
                    </span>
                    <span className="workspace-composer-mode-item-description">
                      {launchModelOptions?.defaultReasoningEffort
                        ? `使用模型默认值：${launchModelOptions.defaultReasoningEffort}`
                        : '清除新会话的思考深度覆盖'}
                    </span>
                  </button>
                  {(launchModelOptions?.availableModels.find((entry) => (
                    entry.model === launchModelOptions.effectiveModelId || entry.id === launchModelOptions.effectiveModelId
                  ))?.supportedReasoningEfforts ?? []).map((effort) => (
                    <button
                      className="workspace-composer-mode-item"
                      disabled={updatingLaunchModelSettings}
                      key={effort}
                      onClick={() => void applyLaunchModelUpdate({ reasoningEffort: effort })}
                      type="button"
                    >
                      <span className="workspace-composer-mode-item-label">
                        {effort}
                        {launchModelOptions?.effectiveReasoningEffort === effort ? ' · 当前' : ''}
                      </span>
                      <span className="workspace-composer-mode-item-description">更新新会话的思考深度</span>
                    </button>
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      <button
        aria-label="发送"
        className="workspace-composer-send"
        disabled={launching || composerText.trim().length === 0}
        type="submit"
      >
        <img alt="" aria-hidden="true" className="workspace-composer-send-icon" src="/icons/send-arrow.svg" />
      </button>
    </form>
  );

  return (
    <main className="workspace-main workspace-main--empty">
      {!sidebarOpen ? (
        <div className="workspace-floating-bar">
          <button
            aria-expanded={sidebarOpen}
            aria-label="展开目录"
            className="workspace-shell-toggle"
            onClick={toggleSidebar}
            type="button"
          >
            ≡
          </button>
          <div className="workspace-shell-pill" title="CodexBridge">
            CodexBridge
          </div>
        </div>
      ) : null}

      <section className={`workspace-empty-state${isComposing ? ' workspace-empty-state--composing' : ''}`}>
        {isComposing ? (
          <div className="workspace-empty-state-compose">
            <div className="workspace-empty-state-compose-copy">
              <p className="workspace-subtle">将在 {getCwdDisplayName(launchCwd)} 中创建新聊天 · {formatPermissionsModeLabel(launchPermissionsMode)} · {launchModelPillLabel}</p>
            </div>
            {composer}
            {launchError ? <p className="workspace-form-error">{launchError}</p> : null}
          </div>
        ) : (
          <div className="workspace-empty-state-inner">
            <h2>我们先从哪里开始呢？</h2>
            {composer}
            <p className="workspace-subtle">
              左侧已准备好 {threads.length} 条会话，新的对话将默认创建在 {getCwdDisplayName(launchCwd)} 中 · {formatPermissionsModeLabel(launchPermissionsMode)} · {launchModelPillLabel}
            </p>
            {launchError ? <p className="workspace-form-error">{launchError}</p> : null}
          </div>
        )}
      </section>
    </main>
  );
}

export function CodexThreadPane({
  initialThreadHasMore,
  initialThreadMessages,
  initialThreadSettings,
  initialThreadSummary,
  threadId,
}: CodexThreadPaneProps) {
  const router = useRouter();
  const {
    isMobileViewport,
    refreshThreads,
    setPreferredLaunchModelSettings,
    setPreferredLaunchPermissionsMode,
    sidebarOpen,
    threads,
    toggleSidebar,
  } = useCodexWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const [permissionsMenuOpen, setPermissionsMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [updatingMeta, setUpdatingMeta] = useState(false);
  const [deletingThread, setDeletingThread] = useState(false);
  const [updatingPermissions, setUpdatingPermissions] = useState(false);
  const [updatingModelSettings, setUpdatingModelSettings] = useState(false);
  const [loadingModelOptions, setLoadingModelOptions] = useState(false);
  const [permissionsMode, setPermissionsMode] = useState<PermissionsMode>(
    initialThreadSettings?.permissionsMode ?? 'default-permissions',
  );
  const [modelOptions, setModelOptions] = useState<ThreadModelOptions | null>(null);
  const [composerText, setComposerText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<WebCodexThreadMessage[]>(initialThreadMessages);
  const [threadHasMore, setThreadHasMore] = useState(initialThreadHasMore);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const permissionsMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const replyStreamRef = useRef<EventSource | null>(null);
  const autoStartedDraftThreadRef = useRef<string | null>(null);
  const [pendingThreadSummary, setPendingThreadSummary] = useState<WebCodexThreadSummary | null>(() => (
    typeof window === 'undefined' ? null : getPendingCreatedThread(threadId)
  ));
  const activeThread = threads.find((entry) => entry.threadId === threadId)
    ?? pendingThreadSummary
    ?? initialThreadSummary
    ?? null;
  const threadDisplayTitle = activeThread?.title ?? '新聊天';
  const threadDisplayMeta = activeThread?.cwd
    ? `${activeThread.cwd} · ${activeThread.updatedAtLabel}`
    : '新的对话已准备就绪';
  const threadViewportVisible = !isMobileViewport || !sidebarOpen;

  function closeReplyStream() {
    replyStreamRef.current?.close();
    replyStreamRef.current = null;
  }

  function replaceStreamAssistantMessages(
    draftId: string,
    timestamp: string,
    assistantText: string,
    commentaryText: string,
    status: ReplyRunSnapshot['status'],
  ) {
    const nextAssistantMessage = buildStreamAssistantMessage(
      draftId,
      timestamp,
      assistantText,
      commentaryText,
      status,
    );
    setThreadMessages((current) => [
      ...current.filter((message) => message.source !== 'stream'),
      nextAssistantMessage,
    ]);
  }

  function replaceStreamFailureMessage(draftId: string, timestamp: string, text: string) {
    setThreadMessages((current) => [
      ...current.filter((message) => message.source !== 'stream'),
      {
        id: `${draftId}:failed`,
        role: 'assistant',
        failed: true,
        pending: false,
        source: 'stream',
        text,
        timestamp,
      },
    ]);
  }

  function applyModelOptionsSnapshot(snapshot: ThreadModelOptions | null) {
    if (!snapshot) {
      return;
    }
    setModelOptions(snapshot);
  }

  async function loadModelOptions(force = false) {
    if ((loadingModelOptions && !force) || updatingModelSettings) {
      return;
    }
    if (modelOptions && !force) {
      return;
    }
    setLoadingModelOptions(true);
    try {
      const response = await fetch(`/api/codex-threads/${encodeURIComponent(threadId)}/model-options`, {
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null) as ThreadModelOptions & { error?: string } | null;
      if (!response.ok || payload?.error) {
        throw new Error((payload?.error && String(payload.error).trim()) || '模型列表加载失败');
      }
      applyModelOptionsSnapshot(payload);
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : '模型列表加载失败');
    } finally {
      setLoadingModelOptions(false);
    }
  }

  function applyRunSnapshot(snapshot: ReplyRunSnapshot, draftId: string, draftTimestamp: string) {
    replaceStreamAssistantMessages(
      draftId,
      draftTimestamp,
      snapshot.assistantText,
      snapshot.commentaryText,
      snapshot.status,
    );

    if (snapshot.status === 'completed') {
      if (Array.isArray(snapshot.items)) {
        setThreadMessages(attachProcessToFinalAssistantMessages(snapshot.items, snapshot.commentaryText));
        setThreadHasMore(Boolean(snapshot.hasMore));
      } else {
        replaceStreamAssistantMessages(
          draftId,
          draftTimestamp,
          snapshot.assistantText,
          snapshot.commentaryText,
          'completed',
        );
      }
      setReplyError(null);
      setSendingReply(false);
      closeReplyStream();
      void refreshThreads();
      const nextThreadId = typeof snapshot.finalThreadId === 'string' ? snapshot.finalThreadId.trim() : '';
      if (nextThreadId && nextThreadId !== threadId) {
        router.push(`/sessions/codex/${encodeURIComponent(nextThreadId)}`, { scroll: false });
      }
      return;
    }

    if (snapshot.status === 'failed') {
      replaceStreamFailureMessage(draftId, draftTimestamp, snapshot.error || snapshot.assistantText || '发送失败');
      setReplyError(snapshot.error || '发送失败');
      setSendingReply(false);
      closeReplyStream();
    }
  }

  function startReplyStream(runId: string, draftId: string, draftTimestamp: string) {
    closeReplyStream();
    const stream = new EventSource(`/api/codex-threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/events`);
    replyStreamRef.current = stream;

    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as ReplyRunSnapshot;
        applyRunSnapshot(snapshot, draftId, draftTimestamp);
      } catch {
        // Ignore malformed SSE chunks.
      }
    };

    stream.addEventListener('snapshot', handleSnapshot);
    stream.addEventListener('started', handleSnapshot);
    stream.addEventListener('assistant', handleSnapshot);
    stream.addEventListener('commentary', handleSnapshot);
    stream.addEventListener('done', handleSnapshot);
    stream.addEventListener('failed', handleSnapshot);
    stream.onerror = () => {
      if (stream.readyState !== EventSource.CLOSED) {
        return;
      }
      replaceStreamFailureMessage(draftId, draftTimestamp, '连接已中断，请稍后重试。');
      setReplyError('连接已中断，请稍后重试。');
      setSendingReply(false);
      closeReplyStream();
    };
  }

  useEffect(() => {
    setThreadMessages(initialThreadMessages);
    setThreadHasMore(initialThreadHasMore);
    setMenuOpen(false);
    setPermissionsMenuOpen(false);
    setModelMenuOpen(false);
    setReplyError(null);
    setSendingReply(false);
    setUpdatingPermissions(false);
    setUpdatingModelSettings(false);
    setPermissionsMode(initialThreadSettings?.permissionsMode ?? 'default-permissions');
    setModelOptions(null);
    setPendingThreadSummary(typeof window === 'undefined' ? null : getPendingCreatedThread(threadId));
    closeReplyStream();
  }, [initialThreadHasMore, initialThreadMessages, initialThreadSettings?.permissionsMode, threadId]);

  useEffect(() => {
    setPreferredLaunchPermissionsMode(permissionsMode);
  }, [permissionsMode, setPreferredLaunchPermissionsMode]);

  useEffect(() => {
    setPreferredLaunchModelSettings({
      model: modelOptions?.model ?? initialThreadSettings?.model ?? null,
      reasoningEffort: modelOptions?.reasoningEffort ?? initialThreadSettings?.reasoningEffort ?? null,
    });
  }, [
    initialThreadSettings?.model,
    initialThreadSettings?.reasoningEffort,
    modelOptions?.model,
    modelOptions?.reasoningEffort,
    setPreferredLaunchModelSettings,
  ]);

  useEffect(() => {
    if (!threads.some((entry) => entry.threadId === threadId)) {
      return;
    }
    setPendingThreadSummary(null);
    const raw = window.sessionStorage.getItem(PENDING_CREATED_THREAD_STORAGE_KEY);
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { threadId?: string };
      if (parsed.threadId === threadId) {
        window.sessionStorage.removeItem(PENDING_CREATED_THREAD_STORAGE_KEY);
      }
    } catch {
      window.sessionStorage.removeItem(PENDING_CREATED_THREAD_STORAGE_KEY);
    }
  }, [threadId, threads]);

  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) {
      return;
    }
    input.style.height = '24px';
    const maxHeight = Math.max(96, Math.round(window.innerHeight * 0.25));
    const nextHeight = Math.max(24, Math.min(input.scrollHeight, maxHeight));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [composerText]);

  useEffect(() => () => {
    closeReplyStream();
  }, []);

  useEffect(() => {
    void loadModelOptions(true);
  }, [threadId]);

  useEffect(() => {
    if (autoStartedDraftThreadRef.current === threadId) {
      return;
    }
    const pendingDraft = takePendingThreadDraft(threadId);
    if (!pendingDraft) {
      return;
    }
    autoStartedDraftThreadRef.current = threadId;
    void submitReplyText(pendingDraft);
  }, [threadId]);

  useEffect(() => {
    function handlePointer(event: MouseEvent) {
      if (
        menuRef.current
        && event.target instanceof Node
        && !menuRef.current.contains(event.target)
      ) {
        setMenuOpen(false);
      }
      if (
        permissionsMenuRef.current
        && event.target instanceof Node
        && !permissionsMenuRef.current.contains(event.target)
      ) {
        setPermissionsMenuOpen(false);
      }
      if (
        modelMenuRef.current
        && event.target instanceof Node
        && !modelMenuRef.current.contains(event.target)
      ) {
        setModelMenuOpen(false);
      }
    }
    if (!menuOpen && !permissionsMenuOpen && !modelMenuOpen) {
      return;
    }
    window.addEventListener('mousedown', handlePointer);
    return () => window.removeEventListener('mousedown', handlePointer);
  }, [menuOpen, permissionsMenuOpen, modelMenuOpen]);

  async function applyThreadAction(action: 'pin' | 'unpin' | 'archive' | 'unarchive' | 'delete') {
    if (updatingMeta) {
      return;
    }
    setUpdatingMeta(true);
    if (action === 'delete') {
      setDeletingThread(true);
    }
    setMenuOpen(false);
    try {
      const response = await fetch(`/api/codex-threads/${encodeURIComponent(threadId)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        return;
      }
      const payload = await response.json() as {
        metadata?: { isDeleted?: boolean };
      };
      await refreshThreads();
      if (payload.metadata?.isDeleted) {
        router.push('/sessions', { scroll: false });
      }
    } finally {
      setDeletingThread(false);
      setUpdatingMeta(false);
    }
  }

  async function submitReplyText(rawText: string) {
    if (sendingReply) {
      return;
    }
    const text = rawText.trim();
    if (!text) {
      return;
    }

    const timestamp = new Date().toISOString();
    const userMessageId = createLocalMessageId('local-user');
    const assistantDraftId = createLocalMessageId('local-assistant');
    const optimisticUserMessage: WebCodexThreadMessage = {
      id: userMessageId,
      role: 'user',
      source: 'local',
      text,
      timestamp,
    };

    setThreadMessages((current) => [
      ...current.filter((message) => message.source !== 'stream'),
      optimisticUserMessage,
      buildStreamAssistantMessage(assistantDraftId, timestamp, '', '', 'queued'),
    ]);
    setComposerText('');
    setSendingReply(true);
    setReplyError(null);
    requestAnimationFrame(() => {
      composerInputRef.current?.focus();
    });

    try {
      const response = await fetch(`/api/codex-threads/${encodeURIComponent(threadId)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json().catch(() => null) as ThreadReplyResponse | null;
      if (!response.ok || !payload?.ok) {
        const errorMessage = (payload?.error && String(payload.error).trim()) || '发送失败';
        replaceStreamFailureMessage(assistantDraftId, timestamp, errorMessage);
        setReplyError(errorMessage);
        setSendingReply(false);
        return;
      }
      const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
      if (!runId) {
        replaceStreamFailureMessage(assistantDraftId, timestamp, '回复启动失败。');
        setReplyError('回复启动失败。');
        setSendingReply(false);
        return;
      }
      startReplyStream(runId, assistantDraftId, timestamp);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '发送失败';
      replaceStreamFailureMessage(assistantDraftId, timestamp, errorMessage);
      setReplyError(errorMessage);
      setSendingReply(false);
    }
  }

  async function handleReplySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitReplyText(composerText);
  }

  async function applyPermissionsMode(mode: PermissionsMode) {
    if (updatingPermissions || mode === permissionsMode) {
      setPermissionsMenuOpen(false);
      return;
    }
    setUpdatingPermissions(true);
    setReplyError(null);
    try {
      const response = await fetch(`/api/codex-threads/${encodeURIComponent(threadId)}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionsMode: mode }),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        permissionsMode?: PermissionsMode;
        error?: string;
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error((payload?.error && String(payload.error).trim()) || '权限模式更新失败');
      }
      setPermissionsMode(payload.permissionsMode ?? mode);
      setPermissionsMenuOpen(false);
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : '权限模式更新失败');
    } finally {
      setUpdatingPermissions(false);
    }
  }

  async function applyModelUpdate(updates: {
    model?: string | null;
    reasoningEffort?: string | null;
  }) {
    if (updatingModelSettings) {
      return;
    }
    setUpdatingModelSettings(true);
    setReplyError(null);
    try {
      const response = await fetch(`/api/codex-threads/${encodeURIComponent(threadId)}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const payload = await response.json().catch(() => null) as (ThreadModelOptions & {
        ok?: boolean;
        error?: string;
        permissionsMode?: PermissionsMode;
      }) | null;
      if (!response.ok || !payload?.ok) {
        throw new Error((payload?.error && String(payload.error).trim()) || '模型设置更新失败');
      }
      applyModelOptionsSnapshot(payload);
      if (payload.permissionsMode) {
        setPermissionsMode(payload.permissionsMode);
      }
      setModelMenuOpen(false);
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : '模型设置更新失败');
    } finally {
      setUpdatingModelSettings(false);
    }
  }

  const effectiveModelOption = modelOptions?.availableModels.find((entry) => (
    entry.model === modelOptions.effectiveModelId || entry.id === modelOptions.effectiveModelId
  )) ?? null;
  const modelPillLabel = formatModelPillLabel(modelOptions, initialThreadSettings);
  const effectiveEffortOptions = effectiveModelOption?.supportedReasoningEfforts ?? [];

  return (
    <main className="workspace-main workspace-main--thread">
      <section className="workspace-thread-page">
        <section className="workspace-thread-topbar">
          <div className="workspace-thread-topbar-inner">
            <div className="workspace-thread-topbar-main">
              {!sidebarOpen ? (
                <button
                  aria-expanded={sidebarOpen}
                  aria-label="展开目录"
                  className="workspace-shell-toggle workspace-thread-toggle"
                  onClick={toggleSidebar}
                  type="button"
                >
                  ≡
                </button>
              ) : null}
              <h2>{threadDisplayTitle}</h2>
              <p className="workspace-copy">{threadDisplayMeta}</p>
            </div>
            {activeThread ? (
              <div className="workspace-thread-menu" ref={menuRef}>
                <button
                  aria-expanded={menuOpen}
                  aria-label="更多操作"
                  className="workspace-thread-menu-trigger"
                  onClick={() => setMenuOpen((current) => !current)}
                  type="button"
                >
                  …
                </button>
                {menuOpen ? (
                  <div className="workspace-thread-menu-popover">
                    <button
                      className="workspace-thread-menu-item"
                      disabled={updatingMeta}
                      onClick={() => void applyThreadAction(activeThread.isPinned ? 'unpin' : 'pin')}
                      type="button"
                    >
                      {activeThread.isPinned ? '取消置顶' : '置顶'}
                    </button>
                    <button
                      className="workspace-thread-menu-item"
                      disabled={updatingMeta}
                      onClick={() => void applyThreadAction(activeThread.isArchived ? 'unarchive' : 'archive')}
                      type="button"
                    >
                      {activeThread.isArchived ? '取消归档' : '归档'}
                    </button>
                    <button
                      className="workspace-thread-menu-item danger"
                      disabled={updatingMeta || deletingThread}
                      onClick={() => void applyThreadAction('delete')}
                      type="button"
                    >
                      {deletingThread ? '删除中…' : '删除'}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="workspace-thread-stream">
          <CodexThreadMessages
            initialHasMore={threadHasMore}
            initialItems={threadMessages}
            threadId={threadId}
            viewportVisible={threadViewportVisible}
          />
        </section>

        <section className="workspace-thread-composer">
          <form className="workspace-composer-shell workspace-composer-shell-live workspace-composer-form" onSubmit={handleReplySubmit}>
            <button className="workspace-composer-leading" disabled={sendingReply} type="button">
              ＋
            </button>
            <textarea
              className="workspace-composer-input"
              ref={composerInputRef}
              onClick={() => composerInputRef.current?.focus()}
              onChange={(replyEvent) => setComposerText(replyEvent.target.value)}
              onFocus={() => composerInputRef.current?.focus()}
              onKeyDown={(keyEvent) => {
                if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
                  keyEvent.preventDefault();
                  keyEvent.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="继续这个对话…"
              rows={1}
              value={composerText}
            />
            <div className="workspace-composer-controls">
              <div className="workspace-composer-mode" ref={permissionsMenuRef}>
                <button
                  aria-expanded={permissionsMenuOpen}
                  aria-label="切换权限模式"
                  className="workspace-composer-mode-trigger"
                  disabled={updatingPermissions}
                  onClick={() => setPermissionsMenuOpen((current) => !current)}
                  type="button"
                >
                  <span>{formatPermissionsModeLabel(permissionsMode)}</span>
                  <span className="workspace-composer-mode-caret">⌄</span>
                </button>
                {permissionsMenuOpen ? (
                  <div className="workspace-composer-mode-menu">
                    {PERMISSIONS_OPTIONS.map((option) => (
                      <button
                        className="workspace-composer-mode-item"
                        disabled={updatingPermissions}
                        key={option.mode}
                        onClick={() => void applyPermissionsMode(option.mode)}
                        type="button"
                      >
                        <span className="workspace-composer-mode-item-label">
                          {option.label}
                          {permissionsMode === option.mode ? ' · 当前' : ''}
                        </span>
                        <span className="workspace-composer-mode-item-description">{option.description}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="workspace-composer-mode" ref={modelMenuRef}>
                <button
                  aria-expanded={modelMenuOpen}
                  aria-label="切换模型"
                  className="workspace-composer-mode-trigger"
                  disabled={loadingModelOptions || updatingModelSettings}
                  onClick={() => {
                    setModelMenuOpen((current) => {
                      const next = !current;
                      if (next) {
                        void loadModelOptions();
                      }
                      return next;
                    });
                  }}
                  type="button"
                >
                  <span>{modelPillLabel}</span>
                  <span className="workspace-composer-mode-caret">⌄</span>
                </button>
                {modelMenuOpen ? (
                  <div className="workspace-composer-mode-menu">
                    <button
                      className="workspace-composer-mode-item"
                      disabled={updatingModelSettings}
                      onClick={() => void applyModelUpdate({ model: null, reasoningEffort: null })}
                      type="button"
                    >
                      <span className="workspace-composer-mode-item-label">使用默认模型</span>
                      <span className="workspace-composer-mode-item-description">清除当前会话的模型与思考深度覆盖</span>
                    </button>
                    {loadingModelOptions && !modelOptions ? (
                      <div className="workspace-composer-mode-item workspace-composer-mode-item-static">
                        <span className="workspace-composer-mode-item-label">正在加载模型…</span>
                      </div>
                    ) : null}
                    {!loadingModelOptions && modelOptions && modelOptions.availableModels.length === 0 ? (
                      <div className="workspace-composer-mode-item workspace-composer-mode-item-static">
                        <span className="workspace-composer-mode-item-label">当前 provider 没有返回可用模型</span>
                      </div>
                    ) : null}
                    {modelOptions?.availableModels.map((option) => (
                      <button
                        className="workspace-composer-mode-item"
                        disabled={updatingModelSettings}
                        key={option.id || option.model}
                        onClick={() => void applyModelUpdate({ model: option.model })}
                        type="button"
                      >
                        <span className="workspace-composer-mode-item-label">
                          {option.model}
                          {modelOptions.effectiveModelId === option.model || modelOptions.effectiveModelId === option.id ? ' · 当前' : ''}
                          {option.isDefault ? ' · 默认' : ''}
                        </span>
                        <span className="workspace-composer-mode-item-description">
                          {option.displayName && option.displayName !== option.model
                            ? `${option.displayName}${option.description ? ` · ${option.description}` : ''}`
                            : (option.description || '选择这个模型用于当前会话')}
                        </span>
                      </button>
                    ))}
                    {effectiveEffortOptions.length > 0 ? (
                      <>
                        <div className="workspace-composer-mode-divider" />
                        <button
                          className="workspace-composer-mode-item"
                          disabled={updatingModelSettings}
                          onClick={() => void applyModelUpdate({ reasoningEffort: null })}
                          type="button"
                        >
                          <span className="workspace-composer-mode-item-label">
                            默认思考深度
                            {modelOptions?.effectiveReasoningEffortSource === 'model_default' ? ' · 当前' : ''}
                          </span>
                          <span className="workspace-composer-mode-item-description">
                            {modelOptions?.defaultReasoningEffort
                              ? `使用模型默认值：${modelOptions.defaultReasoningEffort}`
                              : '清除会话级思考深度覆盖'}
                          </span>
                        </button>
                        {effectiveEffortOptions.map((effort) => (
                          <button
                            className="workspace-composer-mode-item"
                            disabled={updatingModelSettings}
                            key={effort}
                            onClick={() => void applyModelUpdate({ reasoningEffort: effort })}
                            type="button"
                          >
                            <span className="workspace-composer-mode-item-label">
                              {effort}
                              {modelOptions?.effectiveReasoningEffort === effort ? ' · 当前' : ''}
                            </span>
                            <span className="workspace-composer-mode-item-description">更新当前会话的思考深度</span>
                          </button>
                        ))}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <button
              aria-label="发送"
              className="workspace-composer-send"
              disabled={sendingReply || !composerText.trim()}
              type="submit"
            >
              <img alt="" aria-hidden="true" className="workspace-composer-send-icon" src="/icons/send-arrow.svg" />
            </button>
          </form>
          {replyError ? <p className="workspace-reply-error">{replyError}</p> : null}
        </section>
      </section>
    </main>
  );
}
