import { CodexThreadPane } from '@/components/codex-sessions-shell';
import { getWebCodexThreadDetail, getWebCodexThreadRecentMessages, getWebCodexThreadSettings } from '@/lib/server/queries';

export const dynamic = 'force-dynamic';

export default async function CodexThreadDetailPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  const initialThreadDetail = await getWebCodexThreadDetail(threadId);
  const initialMessages = await getWebCodexThreadRecentMessages(threadId, 8);
  const initialSettings = await getWebCodexThreadSettings(threadId);

  return (
    <CodexThreadPane
      initialThreadHasMore={initialMessages.hasMore}
      initialThreadMessages={initialMessages.items}
      initialThreadSettings={initialSettings}
      initialThreadSummary={initialThreadDetail?.thread ?? null}
      threadId={threadId}
    />
  );
}
