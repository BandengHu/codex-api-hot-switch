import { NextResponse } from 'next/server';
import { listWebSessions } from '@/lib/server/queries';

export async function GET() {
  const sessions = await listWebSessions();
  return NextResponse.json({ data: sessions });
}
