import { NextResponse } from 'next/server';
import { getReplyRunManager } from '@/server/reply-run-manager';

type ReplyPayload = {
  text?: string;
};

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const payload = await request.json().catch(() => null) as ReplyPayload | null;
  const text = normalizeText(payload?.text);
  if (!threadId || !text) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  try {
    const run = getReplyRunManager().createRun({
      text,
      threadId,
    });
    return NextResponse.json({
      ok: true,
      runId: run.runId,
      threadId: run.sourceThreadId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message || 'reply_failed' }, { status: 500 });
  }
}
