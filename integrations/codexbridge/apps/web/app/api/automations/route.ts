import { NextResponse } from 'next/server';
import { listWebAutomations } from '@/lib/server/queries';

export async function GET() {
  const automations = await listWebAutomations();
  return NextResponse.json({ data: automations });
}
