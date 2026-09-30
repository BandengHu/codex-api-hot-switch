import { NextResponse } from 'next/server';
import { getWebCodexThreadRecentMessages, listWebCodexThreadMessages } from '@/lib/server/queries';

export async function GET(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const { searchParams } = new URL(request.url);
  const offset = Number.parseInt(searchParams.get('offset') ?? '0', 10);
  const limit = Number.parseInt(searchParams.get('limit') ?? '40', 10);

  const safeOffset = Number.isNaN(offset) ? 0 : Math.max(0, offset);
  const safeLimit = Number.isNaN(limit) ? 40 : Math.max(1, Math.min(limit, 80));

  const data = safeOffset === 0
    ? await getWebCodexThreadRecentMessages(threadId, safeLimit)
    : await listWebCodexThreadMessages(threadId, safeOffset, safeLimit);

  return NextResponse.json(data);
}
