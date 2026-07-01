import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { clearRuntimeJsonCache, getWebPaths, readRuntimeJson } from '@/lib/server/runtime';

type ActionPayload = {
  action?: 'pin' | 'unpin' | 'archive' | 'unarchive' | 'delete';
};

type StoredBridgeSession = {
  providerProfileId: string;
  codexThreadId: string;
};

type StoredProviderProfile = {
  id: string;
  providerKind: string;
};

type StoredThreadMetadata = {
  providerProfileId: string;
  threadId: string;
  alias: string | null;
  archivedAt?: number | null;
  pinnedAt?: number | null;
  deletedAt?: number | null;
  updatedAt: number;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const payload = await request.json().catch(() => null) as ActionPayload | null;
  const action = payload?.action;
  if (!threadId || !action) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const profiles = readRuntimeJson<StoredProviderProfile[]>('provider_profiles.json', []);
  const bridgeSessions = readRuntimeJson<StoredBridgeSession[]>('bridge_sessions.json', []);
  const metadataList = readRuntimeJson<StoredThreadMetadata[]>('thread_metadata.json', []);

  const codexProviderIds = new Set(
    profiles
      .filter((profile) => profile.providerKind === 'openai-native')
      .map((profile) => profile.id),
  );

  const linkedSession = bridgeSessions.find((session) =>
    session.codexThreadId === threadId && codexProviderIds.has(session.providerProfileId),
  ) ?? null;

  const existingMetadata = metadataList.find((entry) =>
    entry.threadId === threadId && codexProviderIds.has(entry.providerProfileId),
  ) ?? null;

  const providerProfileId = linkedSession?.providerProfileId
    ?? existingMetadata?.providerProfileId
    ?? 'openai-default';

  const current = metadataList.find((entry) =>
    entry.providerProfileId === providerProfileId && entry.threadId === threadId,
  ) ?? null;

  const now = Date.now();
  const next: StoredThreadMetadata = {
    providerProfileId,
    threadId,
    alias: current?.alias ?? null,
    archivedAt:
      action === 'archive'
        ? now
        : action === 'unarchive'
          ? null
          : (typeof current?.archivedAt === 'number' ? current.archivedAt : null),
    pinnedAt:
      action === 'pin'
        ? now
        : action === 'unpin'
          ? null
          : (typeof current?.pinnedAt === 'number' ? current.pinnedAt : null),
    deletedAt:
      action === 'delete'
        ? now
        : (typeof current?.deletedAt === 'number' ? current.deletedAt : null),
    updatedAt: now,
  };

  const nextList = [...metadataList];
  const index = nextList.findIndex((entry) =>
    entry.providerProfileId === providerProfileId && entry.threadId === threadId,
  );
  if (index >= 0) {
    nextList[index] = next;
  } else {
    nextList.push(next);
  }

  const { runtimeDir } = getWebPaths();
  fs.writeFileSync(
    path.join(runtimeDir, 'thread_metadata.json'),
    JSON.stringify(nextList, null, 2),
    'utf8',
  );
  clearRuntimeJsonCache('thread_metadata.json');

  return NextResponse.json({
    ok: true,
    threadId,
    metadata: {
      isPinned: typeof next.pinnedAt === 'number',
      isArchived: typeof next.archivedAt === 'number',
      isDeleted: typeof next.deletedAt === 'number',
      updatedAt: next.updatedAt,
    },
  });
}
