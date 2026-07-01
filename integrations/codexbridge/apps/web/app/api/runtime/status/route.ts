import { NextResponse } from 'next/server';
import { getWebRuntimeStatus } from '@/lib/server/queries';

export async function GET() {
  const status = await getWebRuntimeStatus();
  return NextResponse.json({ data: status });
}
