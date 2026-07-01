'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WebCodexThreadMessage } from '@/lib/server/queries';

type CodexThreadMessagesProps = {
  initialItems: WebCodexThreadMessage[];
  initialHasMore: boolean;
  threadId: string;
  viewportVisible?: boolean;
};

type MessageResponse = {
  items: WebCodexThreadMessage[];
  hasMore: boolean;
};

const ESTIMATED_MESSAGE_HEIGHT = 180;
const MESSAGE_GAP = 18;
const VIRTUAL_OVERSCAN_PX = 280;
const HISTORY_PAGE_SIZE = 40;

function buildTailSignature(message: WebCodexThreadMessage | undefined) {
  if (!message) {
    return '';
  }
  const text = message.text ?? '';
  const processText = message.processText ?? '';
  return [
    message.id,
    text.length,
    text.slice(-24),
    processText.length,
    processText.slice(-24),
    message.pending ? '1' : '0',
    message.processPending ? '1' : '0',
  ].join(':');
}

const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ node: _node, ...props }) => (
          <a {...props} rel="noreferrer" target="_blank" />
        ),
        code: ({ className, children, ...props }) => {
          const isBlock = typeof className === 'string' && className.includes('language-');
          if (isBlock) {
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          }
          return (
            <code {...props}>
              {children}
            </code>
          );
        },
      }}
      remarkPlugins={[remarkGfm]}
    >
      {text}
    </ReactMarkdown>
  );
});

function ProcessChevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`thread-message-process-chevron${open ? ' open' : ''}`}
      fill="none"
      height="12"
      viewBox="0 0 12 12"
      width="12"
    >
      <path d="M4 2.5L7.5 6L4 9.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  );
}

type MessageRowProps = {
  message: WebCodexThreadMessage;
  onMeasure: (id: string, height: number) => void;
  onToggleProcess: (messageId: string) => void;
  processOpen: boolean;
};

const MessageRow = memo(function MessageRow({
  message,
  onMeasure,
  onToggleProcess,
  processOpen,
}: MessageRowProps) {
  const rowRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const node = rowRef.current;
    if (!node) {
      return;
    }

    function measure() {
      if (!node) {
        return;
      }
      onMeasure(message.id, node.getBoundingClientRect().height);
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [message.id, onMeasure]);

  return (
    <article
      className={`thread-message ${message.role}${message.pending ? ' pending' : ''}${message.failed ? ' failed' : ''}`}
      ref={rowRef}
    >
      <header className="thread-message-header">
        <strong>{message.role === 'user' ? '你' : 'Codex'}</strong>
        <span>{message.timestamp ? new Date(message.timestamp).toLocaleString('zh-CN') : '未记录'}</span>
      </header>
      <div className="thread-message-stack">
        {message.role === 'assistant' && message.processText ? (
          <div className="thread-message-process">
            <button
              aria-expanded={processOpen}
              className="thread-message-process-toggle"
              onClick={() => onToggleProcess(message.id)}
              type="button"
            >
              <ProcessChevron open={processOpen} />
              <span>{message.processPending ? '正在处理' : '查看过程'}</span>
              {message.processPending ? <em>实时更新中</em> : null}
            </button>
            {processOpen ? (
              <div className="thread-message-process-body">
                <MarkdownMessage text={message.processText} />
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="thread-message-body">
          {message.text
            ? <MarkdownMessage text={message.text} />
            : (
                <p className="thread-message-placeholder">
                  {message.pending ? '正在思考…' : '\u00A0'}
                </p>
              )}
        </div>
      </div>
    </article>
  );
});

type VirtualWindow = {
  bottomPadding: number;
  totalHeight: number;
  topPadding: number;
  visibleItems: WebCodexThreadMessage[];
};

export function CodexThreadMessages({
  initialItems,
  initialHasMore,
  threadId,
  viewportVisible = true,
}: CodexThreadMessagesProps) {
  const hydratedThreadRef = useRef(threadId);
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [openProcesses, setOpenProcesses] = useState<Record<string, boolean>>({});
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [hasQueuedNewerMessages, setHasQueuedNewerMessages] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [heightVersion, setHeightVersion] = useState(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const messageHeightsRef = useRef<Map<string, number>>(new Map());
  const heightUpdateFrameRef = useRef<number | null>(null);
  const scrollUpdateFrameRef = useRef<number | null>(null);
  const previousThreadIdRef = useRef<string | null>(null);
  const previousCountRef = useRef(0);
  const previousTailSignatureRef = useRef('');
  const pinnedRef = useRef(true);
  const restoringOlderRef = useRef(false);
  const olderMetricsRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const virtualWindowRef = useRef<VirtualWindow>({
    bottomPadding: 0,
    totalHeight: 0,
    topPadding: 0,
    visibleItems: initialItems,
  });

  useEffect(() => {
    if (hydratedThreadRef.current !== threadId) {
      hydratedThreadRef.current = threadId;
      setItems(initialItems);
      setHasMore(initialHasMore);
      setShowJumpButton(false);
      setHasQueuedNewerMessages(false);
      setScrollTop(0);
      messageHeightsRef.current.clear();
      setHeightVersion((current) => current + 1);
      return;
    }

    setItems((current) => {
      const incomingIds = new Set(initialItems.map((message) => message.id));
      const preservedOlderHistory = current.filter((message) => (
        message.source === 'history' && !incomingIds.has(message.id)
      ));
      return [...preservedOlderHistory, ...initialItems];
    });
  }, [initialHasMore, initialItems, threadId]);

  useEffect(() => {
    setOpenProcesses({});
    messageHeightsRef.current.clear();
    setHeightVersion((current) => current + 1);
    virtualWindowRef.current = {
      bottomPadding: 0,
      totalHeight: 0,
      topPadding: 0,
      visibleItems: initialItems,
    };
  }, [threadId]);

  useEffect(() => () => {
    if (heightUpdateFrameRef.current !== null) {
      cancelAnimationFrame(heightUpdateFrameRef.current);
    }
    if (scrollUpdateFrameRef.current !== null) {
      cancelAnimationFrame(scrollUpdateFrameRef.current);
    }
  }, []);

  useEffect(() => {
    setOpenProcesses((current) => {
      let changed = false;
      const next = { ...current };
      for (const message of items) {
        if (
          message.role === 'assistant'
          && message.processPending
          && message.processText
          && typeof next[message.id] === 'undefined'
        ) {
          next[message.id] = true;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [items]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    function commitScrollState() {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      pinnedRef.current = distanceFromBottom < 48;
      const roundedScrollTop = Math.round(viewport.scrollTop / 12) * 12;
      setScrollTop((current) => (current === roundedScrollTop ? current : roundedScrollTop));
      setViewportHeight((current) => (current === viewport.clientHeight ? current : viewport.clientHeight));
      setShowJumpButton((current) => (current === !pinnedRef.current ? current : !pinnedRef.current));
      if (pinnedRef.current) {
        setHasQueuedNewerMessages((current) => (current ? false : current));
      }
    }

    function updatePinnedState() {
      if (scrollUpdateFrameRef.current !== null) {
        return;
      }
      scrollUpdateFrameRef.current = requestAnimationFrame(() => {
        scrollUpdateFrameRef.current = null;
        commitScrollState();
      });
    }

    commitScrollState();
    const resizeObserver = new ResizeObserver(commitScrollState);
    resizeObserver.observe(viewport);
    viewport.addEventListener('scroll', updatePinnedState, { passive: true });
    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener('scroll', updatePinnedState);
      if (scrollUpdateFrameRef.current !== null) {
        cancelAnimationFrame(scrollUpdateFrameRef.current);
        scrollUpdateFrameRef.current = null;
      }
    };
  }, [threadId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      previousThreadIdRef.current = threadId;
      previousCountRef.current = items.length;
      previousTailSignatureRef.current = buildTailSignature(items.at(-1));
      return;
    }

    if (restoringOlderRef.current && olderMetricsRef.current) {
      const previousMetrics = olderMetricsRef.current;
      viewport.scrollTop = viewport.scrollHeight - previousMetrics.scrollHeight + previousMetrics.scrollTop;
      restoringOlderRef.current = false;
      olderMetricsRef.current = null;
      previousThreadIdRef.current = threadId;
      previousCountRef.current = items.length;
      previousTailSignatureRef.current = buildTailSignature(items.at(-1));
      return;
    }

    const threadChanged = previousThreadIdRef.current !== threadId;
    const countGrew = items.length > previousCountRef.current;
    const nextTailSignature = buildTailSignature(items.at(-1));
    const tailChanged = previousTailSignatureRef.current !== nextTailSignature;
    if (threadChanged || ((countGrew || tailChanged) && pinnedRef.current)) {
      viewport.scrollTop = viewport.scrollHeight;
      pinnedRef.current = true;
      setShowJumpButton(false);
      setHasQueuedNewerMessages(false);
    } else if (!threadChanged && (countGrew || tailChanged) && !pinnedRef.current) {
      setShowJumpButton(true);
      setHasQueuedNewerMessages(true);
    }

    previousThreadIdRef.current = threadId;
    previousCountRef.current = items.length;
    previousTailSignatureRef.current = nextTailSignature;
  }, [heightVersion, items, threadId]);

  useLayoutEffect(() => {
    if (!viewportVisible) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
      pinnedRef.current = true;
      setShowJumpButton(false);
      setHasQueuedNewerMessages(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [threadId, viewportVisible]);

  const handleMessageMeasure = useCallback((id: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    const previous = messageHeightsRef.current.get(id);
    if (typeof previous === 'number' && Math.abs(previous - height) < 1) {
      return;
    }
    messageHeightsRef.current.set(id, height);
    if (heightUpdateFrameRef.current !== null) {
      return;
    }
    heightUpdateFrameRef.current = requestAnimationFrame(() => {
      heightUpdateFrameRef.current = null;
      setHeightVersion((current) => current + 1);
    });
  }, []);

  useEffect(() => {
    if (!hasMore || loading) {
      return;
    }
    const node = sentinelRef.current;
    const root = viewportRef.current;
    if (!node || !root) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      void loadMore();
    }, {
      root,
      rootMargin: '960px 0px 0px 0px',
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, items.length, threadId]);

  async function loadMore() {
    if (loading || !hasMore) {
      return;
    }
    const viewport = viewportRef.current;
    if (viewport) {
      restoringOlderRef.current = true;
      olderMetricsRef.current = {
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      };
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/api/codex-threads/${encodeURIComponent(threadId)}/messages?offset=${items.length}&limit=${HISTORY_PAGE_SIZE}`,
        { cache: 'no-store' },
      );
      if (!response.ok) {
        return;
      }
      const data = await response.json() as MessageResponse;
      setItems((current) => [...data.items, ...current]);
      setHasMore(data.hasMore);
    } finally {
      setLoading(false);
    }
  }

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior,
    });
    pinnedRef.current = true;
    setShowJumpButton(false);
    setHasQueuedNewerMessages(false);
  }

  const toggleProcess = useCallback((messageId: string) => {
    setOpenProcesses((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  }, []);

  const virtualState = useMemo(() => {
    if (items.length === 0) {
      return {
        bottomPadding: 0,
        totalHeight: 0,
        topPadding: 0,
        visibleItems: [] as WebCodexThreadMessage[],
      };
    }

    const loadMoreHeight = hasMore ? (sentinelRef.current?.offsetHeight ?? 56) : 0;
    const listScrollTop = Math.max(0, scrollTop - loadMoreHeight);
    const visibleTop = Math.max(0, listScrollTop - VIRTUAL_OVERSCAN_PX);
    const visibleBottom = listScrollTop + viewportHeight + VIRTUAL_OVERSCAN_PX;

    let offset = 0;
    let startIndex = 0;
    let endIndex = items.length - 1;
    let foundStart = false;

    for (let index = 0; index < items.length; index += 1) {
      const message = items[index];
      const height = messageHeightsRef.current.get(message.id) ?? ESTIMATED_MESSAGE_HEIGHT;
      const itemEnd = offset + height;
      if (!foundStart && itemEnd >= visibleTop) {
        startIndex = index;
        foundStart = true;
      }
      if (offset <= visibleBottom) {
        endIndex = index;
      }
      offset += height + (index === items.length - 1 ? 0 : MESSAGE_GAP);
    }

    const totalHeight = offset;
    let topPadding = 0;
    for (let index = 0; index < startIndex; index += 1) {
      const message = items[index];
      topPadding += (messageHeightsRef.current.get(message.id) ?? ESTIMATED_MESSAGE_HEIGHT) + MESSAGE_GAP;
    }

    let renderedHeight = 0;
    for (let index = startIndex; index <= endIndex; index += 1) {
      const message = items[index];
      renderedHeight += messageHeightsRef.current.get(message.id) ?? ESTIMATED_MESSAGE_HEIGHT;
      if (index < endIndex) {
        renderedHeight += MESSAGE_GAP;
      }
    }

    const nextState = {
      bottomPadding: Math.max(0, totalHeight - topPadding - renderedHeight),
      totalHeight,
      topPadding,
      visibleItems: items.slice(startIndex, endIndex + 1),
    };
    virtualWindowRef.current = nextState;
    return nextState;
  }, [hasMore, heightVersion, items, scrollTop, viewportHeight]);

  return (
    <div className="thread-messages">
      <div className="thread-messages-viewport" ref={viewportRef}>
        {hasMore ? (
          <div className="thread-messages-load-more" ref={sentinelRef}>
            <button
              className="workspace-shell-toggle"
              disabled={loading}
              onClick={() => void loadMore()}
              type="button"
            >
              {loading ? '继续加载中…' : '继续加载更早消息'}
            </button>
          </div>
        ) : null}

        {items.length === 0 ? (
          <div className="thread-messages-empty" aria-hidden="true" />
        ) : (
          <div
            className="thread-message-virtual-list"
            style={{ height: `${virtualState.totalHeight}px` }}
          >
            <div
              className="thread-message-list"
              style={{
                paddingBottom: `${virtualState.bottomPadding}px`,
                transform: `translateY(${virtualState.topPadding}px)`,
              }}
            >
              {virtualState.visibleItems.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  onMeasure={handleMessageMeasure}
                  onToggleProcess={toggleProcess}
                  processOpen={Boolean(openProcesses[message.id])}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      {showJumpButton ? (
        <div className="thread-messages-jump-wrap">
          <button
            className="thread-messages-jump"
            onClick={() => scrollToBottom('smooth')}
            type="button"
          >
            <span>{hasQueuedNewerMessages ? '有新消息，回到底部' : '回到底部'}</span>
            <strong>↓</strong>
          </button>
        </div>
      ) : null}
    </div>
  );
}
