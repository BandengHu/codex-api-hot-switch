'use client';

import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react';

type WorkspaceShellProps = {
  children: ReactNode;
  contextPanel?: ReactNode;
  onSidebarWidthChange: (nextWidth: number) => void;
  sidebar: ReactNode;
  sidebarOpen: boolean;
  sidebarWidth: number;
};

export function WorkspaceShell({
  children,
  contextPanel,
  onSidebarWidthChange,
  sidebar,
  sidebarOpen,
  sidebarWidth,
}: WorkspaceShellProps) {
  const resizeOriginRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent | globalThis.PointerEvent) {
      const origin = resizeOriginRef.current;
      if (!origin) {
        return;
      }
      const delta = event.clientX - origin.startX;
      onSidebarWidthChange(origin.startWidth + delta);
    }

    function handlePointerUp(event: globalThis.PointerEvent) {
      const origin = resizeOriginRef.current;
      if (!origin || event.pointerId !== origin.pointerId) {
        return;
      }
      resizeOriginRef.current = null;
      document.body.classList.remove('workspace-resizing');
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      document.body.classList.remove('workspace-resizing');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [onSidebarWidthChange]);

  function handleResizeStart(event: PointerEvent<HTMLButtonElement>) {
    resizeOriginRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
    };
    document.body.classList.add('workspace-resizing');
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  return (
    <section
      className={`workspace-shell${sidebarOpen ? ' sidebar-open' : ' sidebar-closed'}${contextPanel ? ' has-context-panel' : ''}`}
      style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}
    >
      <div className="workspace-shell-body">
        <div className="workspace-shell-sidebar">{sidebar}</div>
        {sidebarOpen ? (
          <button
            aria-label="调整目录宽度"
            className="workspace-shell-resizer"
            onPointerDown={handleResizeStart}
            type="button"
          />
        ) : null}
        <div className="workspace-shell-main">{children}</div>
        {contextPanel ? (
          <aside className="workspace-shell-context-panel">
            {contextPanel}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
