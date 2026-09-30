import { NextResponse } from 'next/server';
import { getWebSessionDetail } from '@/lib/server/queries';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  const detail = await getWebSessionDetail(sessionId);
  if (!detail) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json({ data: detail });
}
