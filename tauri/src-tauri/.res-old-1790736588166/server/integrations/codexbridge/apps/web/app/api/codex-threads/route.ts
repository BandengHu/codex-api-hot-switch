import { NextResponse } from 'next/server';
import { listWebCodexThreads } from '@/lib/server/queries';

export async function GET() {
  const data = await listWebCodexThreads();
  return NextResponse.json({ data });
}
