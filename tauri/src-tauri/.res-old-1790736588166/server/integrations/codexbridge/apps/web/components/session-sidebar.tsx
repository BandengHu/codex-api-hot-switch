'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { WebCodexThreadSummary } from '@/lib/server/queries';

type SessionSidebarProps = {
  sessions: WebCodexThreadSummary[];
  activeThreadId?: string | null;
  onCloseSidebar?: () => void;
  onStartDraftThread: (options?: {
    cwd?: string | null;
  }) => {
    cwd: string | null;
    id: string;
    startedAt: number;
  };
  onToggleSidebar?: () => void;
  onThreadsChanged?: () => Promise<void>;
  preferredLaunchCwd: string | null;
  setThreads: Dispatch<SetStateAction<WebCodexThreadSummary[]>>;
};

type SessionGroup = {
  key: string;
  label: string;
  cwd: string | null;
  isPinned: boolean;
  sessions: WebCodexThreadSummary[];
};

const SIDEBAR_SCROLL_KEY = 'codexbridge-web-sidebar-scroll-top';

function getProjectLabel(cwd: string | null) {
  if (!cwd) {
    return '未归类';
  }
  const normalized = cwd.replace(/\/+$/u, '');
  const parts = normalized.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  return base || normalized || '未归类';
}

function buildGroups(sessions: WebCodexThreadSummary[]) {
  const pinned = sessions.filter((session) => session.isPinned);
  const normal = sessions.filter((session) => !session.isPinned && !session.isArchived);
  const archived = sessions.filter((session) => session.isArchived);

  const map = new Map<string, SessionGroup>();
  for (const session of normal) {
    const key = session.folderKey?.trim() || session.cwd?.trim() || '__ungrouped__';
    const current = map.get(key);
    if (current) {
      current.sessions.push(session);
      current.isPinned = current.isPinned || session.folderPinned;
      if (!current.cwd && session.cwd) {
        current.cwd = session.cwd;
      }
      if (!current.label && session.folderLabel?.trim()) {
        current.label = session.folderLabel.trim();
      }
      continue;
    }
    map.set(key, {
      key,
      label: session.folderLabel?.trim() || getProjectLabel(session.cwd),
      cwd: session.cwd,
      isPinned: session.folderPinned,
      sessions: [session],
    });
  }

  const groups: SessionGroup[] = Array.from(map.values())
    .map((group) => ({
      ...group,
      sessions: group.sessions.sort((left, right) => right.updatedAt - left.updatedAt),
    }))
    .sort((left, right) => {
      if (left.isPinned !== right.isPinned) {
        return left.isPinned ? -1 : 1;
      }
      return left.label.localeCompare(right.label, 'zh-CN');
    });

  return {
    pinned: pinned.sort((left, right) => right.updatedAt - left.updatedAt),
    groups,
    archived: archived.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 10),
  };
}

function SessionEntry({
  busy,
  onArchive,
  session,
  active,
  onNavigate,
  onPin,
}: {
  busy: boolean;
  onArchive: () => void;
  session: WebCodexThreadSummary;
  active: boolean;
  onNavigate?: () => void;
  onPin: () => void;
}) {
  return (
    <div className={`sidebar-session-row${active ? ' active' : ''}`}>
      <button
        aria-current={active ? 'page' : undefined}
        className={`sidebar-session-entry${active ? ' active' : ''}`}
        onClick={() => {
          onNavigate?.();
        }}
        title={session.title}
        type="button"
      >
        <span className="sidebar-session-title">{session.title}</span>
      </button>
      <div className="sidebar-session-actions">
        <button
          aria-label={session.isPinned ? '取消置顶' : '置顶'}
          className={`sidebar-session-action-button${session.isPinned ? ' active' : ''}`}
          disabled={busy}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPin();
          }}
          title={session.isPinned ? '取消置顶' : '置顶'}
          type="button"
        >
          <img alt="" aria-hidden="true" className="sidebar-session-action-icon" src="/icons/pin.svg" />
        </button>
        <button
          aria-label={session.isArchived ? '取消归档' : '归档'}
          className={`sidebar-session-action-button${session.isArchived ? ' active' : ''}`}
          disabled={busy}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onArchive();
          }}
          title={session.isArchived ? '取消归档' : '归档'}
          type="button"
        >
          <img alt="" aria-hidden="true" className="sidebar-session-action-icon" src="/icons/archive.svg" />
        </button>
      </div>
    </div>
  );
}

export function SessionSidebar({
  sessions,
  activeThreadId = null,
  onCloseSidebar,
  onStartDraftThread,
  onToggleSidebar,
  onThreadsChanged,
  preferredLaunchCwd,
  setThreads,
}: SessionSidebarProps) {
  const router = useRouter();
  const [openGroupMenu, setOpenGroupMenu] = useState<string | null>(null);
  const [folderActioningKey, setFolderActioningKey] = useState<string | null>(null);
  const [threadActioningId, setThreadActioningId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const restoredScrollRef = useRef(false);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredSessions = useMemo(() => {
    if (!normalizedSearchQuery) {
      return sessions;
    }
    return sessions.filter((session) => {
      const haystacks = [
        session.title,
        session.cwd,
        session.folderLabel,
        session.alias,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.toLowerCase());
      return haystacks.some((value) => value.includes(normalizedSearchQuery));
    });
  }, [normalizedSearchQuery, sessions]);
  const { pinned, groups, archived } = useMemo(
    () => buildGroups(filteredSessions),
    [filteredSessions],
  );

  useEffect(() => {
    function handlePointer(event: MouseEvent) {
      if (!menuRef.current) {
        return;
      }
      if (event.target instanceof Node && !menuRef.current.contains(event.target)) {
        setOpenGroupMenu(null);
      }
    }
    if (!openGroupMenu) {
      return;
    }
    window.addEventListener('mousedown', handlePointer);
    return () => window.removeEventListener('mousedown', handlePointer);
  }, [openGroupMenu]);

  useEffect(() => {
    if (restoredScrollRef.current) {
      return;
    }
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) {
      return;
    }
    const raw = window.sessionStorage.getItem(SIDEBAR_SCROLL_KEY);
    const nextScrollTop = raw ? Number(raw) : 0;
    if (Number.isFinite(nextScrollTop) && nextScrollTop > 0) {
      scrollContainer.scrollTop = nextScrollTop;
    }
    restoredScrollRef.current = true;
  }, [sessions.length]);

  function persistSidebarScroll() {
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    window.sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(scrollTop));
  }

  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchOpen]);

  function getProjectLabelFromCwd(cwd: string | null) {
    if (!cwd) {
      return '默认位置';
    }
    return getProjectLabel(cwd);
  }

  function handleCreateDraftThread(cwd?: string | null) {
    const targetCwd = cwd?.trim() || preferredLaunchCwd || null;
    setOpenGroupMenu(null);
    onStartDraftThread({ cwd: targetCwd });
    persistSidebarScroll();
    onCloseSidebar?.();
    router.push('/sessions', { scroll: false });
  }

  function navigateToThread(href: string) {
    persistSidebarScroll();
    onCloseSidebar?.();
    router.push(href, { scroll: false });
  }

  function createThreadForFolder(cwd: string | null) {
    if (!cwd) {
      return;
    }
    handleCreateDraftThread(cwd);
  }

  async function applySessionAction(
    session: WebCodexThreadSummary,
    action: 'pin' | 'unpin' | 'archive' | 'unarchive',
  ) {
    if (threadActioningId) {
      return;
    }

    const actioningKey = `${session.threadId}:${action}`;
    setThreadActioningId(actioningKey);

    setThreads((current) => current.map((entry) => {
      if (entry.threadId !== session.threadId) {
        return entry;
      }
      return {
        ...entry,
        isArchived: action === 'archive'
          ? true
          : action === 'unarchive'
            ? false
            : entry.isArchived,
        isPinned: action === 'pin'
          ? true
          : action === 'unpin'
            ? false
            : entry.isPinned,
        updatedAt: Date.now(),
        updatedAtLabel: '刚刚',
      };
    }));

    try {
      const response = await fetch(`/api/codex-threads/${encodeURIComponent(session.threadId)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error((payload?.error && String(payload.error).trim()) || '操作失败');
      }
      await onThreadsChanged?.();
    } catch (error) {
      setThreads((current) => current.map((entry) => (
        entry.threadId === session.threadId ? session : entry
      )));
      window.alert(error instanceof Error ? error.message : '操作失败');
    } finally {
      setThreadActioningId(null);
    }
  }

  async function applyFolderAction(
    group: SessionGroup,
    action: 'pin' | 'unpin' | 'rename' | 'archive' | 'remove',
  ) {
    const cwd = group.cwd?.trim();
    if (!cwd || folderActioningKey) {
      return;
    }

    let value: string | null | undefined;
    if (action === 'rename') {
      const nextName = window.prompt('输入新的文件夹显示名称', group.label);
      if (nextName === null) {
        return;
      }
      value = nextName.trim();
    }

    if (action === 'archive') {
      const confirmed = window.confirm(`归档“${group.label}”下的全部对话？`);
      if (!confirmed) {
        return;
      }
    }

    if (action === 'remove') {
      const confirmed = window.confirm(`从侧栏移除“${group.label}”？`);
      if (!confirmed) {
        return;
      }
    }

    setFolderActioningKey(group.key);
    setOpenGroupMenu(null);
    try {
      const response = await fetch('/api/codex-folders/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          action,
          value,
        }),
      });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        window.alert((payload?.error && String(payload.error).trim()) || '操作失败');
        return;
      }
      await onThreadsChanged?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '操作失败');
    } finally {
      setFolderActioningKey(null);
    }
  }

  return (
    <aside className="workspace-sidebar">
      <div className="workspace-sidebar-top">
        <div className="workspace-sidebar-brand-row">
          <h1 className="workspace-sidebar-brand">CodexBridge</h1>
          <button
            aria-label="收起目录"
            className="workspace-sidebar-collapse"
            onClick={onToggleSidebar}
            type="button"
          >
            <span aria-hidden="true">⟨</span>
          </button>
        </div>
        <div className="workspace-sidebar-shortcuts">
          <button
            className="workspace-sidebar-shortcut"
            onClick={() => {
              handleCreateDraftThread();
            }}
            type="button"
          >
            <img alt="" aria-hidden="true" className="workspace-sidebar-shortcut-icon" src="/icons/new-thread.svg" />
            <span>新聊天</span>
          </button>
          <button
            aria-expanded={searchOpen}
            className="workspace-sidebar-shortcut"
            onClick={() => {
              setSearchOpen((current) => {
                const next = !current;
                if (!next) {
                  setSearchQuery('');
                }
                return next;
              });
            }}
            type="button"
          >
            <span aria-hidden="true">⌕</span>
            <span>搜索聊天</span>
          </button>
          {searchOpen ? (
            <label className="workspace-sidebar-search">
              <span className="workspace-sidebar-search-icon" aria-hidden="true">⌕</span>
              <input
                className="workspace-sidebar-search-input"
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setSearchOpen(false);
                    setSearchQuery('');
                  }
                }}
                placeholder="搜索标题、目录或分组"
                ref={searchInputRef}
                type="search"
                value={searchQuery}
              />
            </label>
          ) : null}
        </div>
      </div>

      <div className="workspace-sidebar-scroll" onScroll={persistSidebarScroll} ref={scrollRef}>
        {searchOpen && normalizedSearchQuery ? (
          <section className="sidebar-section">
            <h2 className="sidebar-section-title">
              搜索结果
              <span className="sidebar-section-title-count"> {filteredSessions.length}</span>
            </h2>
            <div className="sidebar-session-list">
              {filteredSessions.length === 0 ? (
                <div className="sidebar-empty">没有匹配的会话。</div>
              ) : (
                filteredSessions
                  .slice()
                  .sort((left, right) => right.updatedAt - left.updatedAt)
                  .map((session) => (
                    <SessionEntry
                      key={session.threadId}
                      active={session.threadId === activeThreadId}
                      busy={threadActioningId?.startsWith(`${session.threadId}:`) ?? false}
                      onArchive={() => void applySessionAction(session, session.isArchived ? 'unarchive' : 'archive')}
                      onNavigate={() => {
                        navigateToThread(session.href);
                      }}
                      onPin={() => void applySessionAction(session, session.isPinned ? 'unpin' : 'pin')}
                      session={session}
                    />
                  ))
              )}
            </div>
          </section>
        ) : null}

        {!normalizedSearchQuery ? (
          <>
        {pinned.length > 0 ? (
          <section className="sidebar-section">
            <h2 className="sidebar-section-title">置顶</h2>
            <div className="sidebar-session-list">
              {pinned.map((session) => (
                <SessionEntry
                  key={session.threadId}
                  active={session.threadId === activeThreadId}
                  busy={threadActioningId?.startsWith(`${session.threadId}:`) ?? false}
                  onArchive={() => void applySessionAction(session, session.isArchived ? 'unarchive' : 'archive')}
                  onNavigate={() => {
                    navigateToThread(session.href);
                  }}
                  onPin={() => void applySessionAction(session, session.isPinned ? 'unpin' : 'pin')}
                  session={session}
                />
              ))}
            </div>
          </section>
        ) : null}

        <section className="sidebar-section">
          <h2 className="sidebar-section-title">项目</h2>
          <div className="sidebar-project-groups">
            {groups.length === 0 ? (
              <div className="sidebar-empty">当前没有可展示的 Codex 会话。</div>
            ) : (
              groups.map((group) => (
                <details className="sidebar-project-group" key={group.key} open>
                  <summary className="sidebar-project-header">
                    <span aria-hidden="true" className="sidebar-folder-icon" />
                    <span className="sidebar-project-label">{group.label}</span>
                    <div
                      className="sidebar-project-actions"
                      data-open={openGroupMenu === group.key ? 'true' : 'false'}
                      onClick={(event) => event.preventDefault()}
                    >
                      <div className="sidebar-project-menu" ref={openGroupMenu === group.key ? menuRef : null}>
                        <button
                          aria-expanded={openGroupMenu === group.key}
                          aria-label={`${group.label} 更多操作`}
                          className="sidebar-project-action-button sidebar-project-action-more"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setOpenGroupMenu((current) => current === group.key ? null : group.key);
                          }}
                          title="更多操作"
                          type="button"
                        >
                          <img alt="" aria-hidden="true" className="sidebar-project-action-icon" src="/icons/more-horizontal.svg" />
                        </button>
                        {openGroupMenu === group.key ? (
                          <div className="sidebar-project-menu-popover">
                            <button
                              className="sidebar-project-menu-item"
                              disabled={folderActioningKey === group.key}
                              onClick={() => void applyFolderAction(group, group.isPinned ? 'unpin' : 'pin')}
                              type="button"
                            >
                              <span className="sidebar-project-menu-item-inner">
                                <img alt="" aria-hidden="true" className="sidebar-project-menu-item-icon" src="/icons/pin.svg" />
                                <span>{group.isPinned ? '取消置顶' : '置顶'}</span>
                              </span>
                            </button>
                            <button
                              className="sidebar-project-menu-item"
                              disabled={folderActioningKey === group.key}
                              onClick={() => void applyFolderAction(group, 'rename')}
                              type="button"
                            >
                              <span className="sidebar-project-menu-item-inner">
                                <img alt="" aria-hidden="true" className="sidebar-project-menu-item-icon" src="/icons/rename.svg" />
                                <span>重命名</span>
                              </span>
                            </button>
                            <button
                              className="sidebar-project-menu-item"
                              disabled={folderActioningKey === group.key}
                              onClick={() => void applyFolderAction(group, 'archive')}
                              type="button"
                            >
                              <span className="sidebar-project-menu-item-inner">
                                <img alt="" aria-hidden="true" className="sidebar-project-menu-item-icon" src="/icons/archive.svg" />
                                <span>归档</span>
                              </span>
                            </button>
                            <button
                              className="sidebar-project-menu-item danger"
                              disabled={folderActioningKey === group.key}
                              onClick={() => void applyFolderAction(group, 'remove')}
                              type="button"
                            >
                              <span className="sidebar-project-menu-item-inner">
                                <img alt="" aria-hidden="true" className="sidebar-project-menu-item-icon" src="/icons/remove.svg" />
                                <span>移除</span>
                              </span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <button
                        aria-label={`在 ${group.label} 下新建会话`}
                        className="sidebar-project-action-button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          createThreadForFolder(group.cwd);
                        }}
                        title="在当前文件夹下新建会话"
                        type="button"
                      >
                        <img alt="" aria-hidden="true" className="sidebar-project-action-icon" src="/icons/new-thread.svg" />
                      </button>
                    </div>
                  </summary>
                  <div className="sidebar-session-list">
                    {group.sessions.map((session) => (
                      <SessionEntry
                        key={session.threadId}
                        active={session.threadId === activeThreadId}
                        busy={threadActioningId?.startsWith(`${session.threadId}:`) ?? false}
                        onArchive={() => void applySessionAction(session, session.isArchived ? 'unarchive' : 'archive')}
                        onNavigate={() => {
                          navigateToThread(session.href);
                        }}
                        onPin={() => void applySessionAction(session, session.isPinned ? 'unpin' : 'pin')}
                        session={session}
                      />
                    ))}
                  </div>
                </details>
              ))
            )}
          </div>
        </section>

        {archived.length > 0 ? (
          <section className="sidebar-section">
            <h2 className="sidebar-section-title">最近归档</h2>
            <div className="sidebar-session-list">
              {archived.map((session) => (
                <SessionEntry
                  key={session.threadId}
                  active={session.threadId === activeThreadId}
                  busy={threadActioningId?.startsWith(`${session.threadId}:`) ?? false}
                  onArchive={() => void applySessionAction(session, session.isArchived ? 'unarchive' : 'archive')}
                  onNavigate={() => {
                    navigateToThread(session.href);
                  }}
                  onPin={() => void applySessionAction(session, session.isPinned ? 'unpin' : 'pin')}
                  session={session}
                />
              ))}
            </div>
          </section>
        ) : null}
          </>
        ) : null}
      </div>

      <div className="workspace-sidebar-footer">
        <a className="workspace-settings-link" href="/runtime">
          <span className="workspace-settings-icon">⚙</span>
          <span>设置</span>
        </a>
        <p className="workspace-sidebar-footnote">
          默认新聊天将创建在 {getProjectLabelFromCwd(preferredLaunchCwd)} 中
        </p>
      </div>
    </aside>
  );
}
