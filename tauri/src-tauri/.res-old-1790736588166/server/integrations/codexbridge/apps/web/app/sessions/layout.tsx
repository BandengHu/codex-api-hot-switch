import type { ReactNode } from 'react';
import { CodexWorkspaceProvider } from '@/components/codex-workspace-context';
import { listWebCodexThreads } from '@/lib/server/queries';

export const dynamic = 'force-dynamic';

export default async function SessionsLayout({
  children,
}: {
  children: ReactNode;
}) {
  const initialThreads = await listWebCodexThreads();

  return (
    <CodexWorkspaceProvider initialThreads={initialThreads}>
      {children}
    </CodexWorkspaceProvider>
  );
}
