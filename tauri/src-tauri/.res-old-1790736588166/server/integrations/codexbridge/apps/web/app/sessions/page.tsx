import { CodexSessionsEmptyState } from '@/components/codex-sessions-shell';

export const dynamic = 'force-dynamic';

export default async function SessionsPage() {
  return <CodexSessionsEmptyState />;
}
