import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { clearRuntimeJsonCache, getWebPaths, readRuntimeJson } from '@/lib/server/runtime';
import { listWebCodexThreads } from '@/lib/server/queries';

type FolderActionPayload = {
  action?: 'pin' | 'unpin' | 'rename' | 'archive' | 'remove';
  cwd?: string;
  value?: string | null;
};

type StoredFolderMetadata = {
  cwd: string;
  alias?: string | null;
  pinnedAt?: number | null;
  removedAt?: number | null;
  updatedAt: number;
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

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null) as FolderActionPayload | null;
  const action = payload?.action;
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : '';
  const nextAlias = typeof payload?.value === 'string' ? payload.value.trim() : '';

  if (!action || !cwd) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const { runtimeDir } = getWebPaths();
  const folderMetadataList = readRuntimeJson<StoredFolderMetadata[]>('folder_metadata.json', []);
  const threadMetadataList = readRuntimeJson<StoredThreadMetadata[]>('thread_metadata.json', []);

  const now = Date.now();
  const nextFolderMetadataList = [...folderMetadataList];
  const currentFolderIndex = nextFolderMetadataList.findIndex((entry) => entry.cwd.trim() === cwd);
  const currentFolder = currentFolderIndex >= 0 ? nextFolderMetadataList[currentFolderIndex] : null;

  const nextFolder: StoredFolderMetadata = {
    cwd,
    alias:
      action === 'rename'
        ? (nextAlias || null)
        : (typeof currentFolder?.alias === 'string' ? currentFolder.alias : null),
    pinnedAt:
      action === 'pin'
        ? now
        : action === 'unpin'
          ? null
          : (typeof currentFolder?.pinnedAt === 'number' ? currentFolder.pinnedAt : null),
    removedAt:
      action === 'remove'
        ? now
        : (typeof currentFolder?.removedAt === 'number' ? currentFolder.removedAt : null),
    updatedAt: now,
  };

  if (currentFolderIndex >= 0) {
    nextFolderMetadataList[currentFolderIndex] = nextFolder;
  } else {
    nextFolderMetadataList.push(nextFolder);
  }

  let nextThreadMetadataList = threadMetadataList;
  if (action === 'archive') {
    const threadList = await listWebCodexThreads();
    const targetThreads = threadList.filter((thread) => (thread.cwd ?? '').trim() === cwd);
    if (targetThreads.length > 0) {
      const threadIdSet = new Set(targetThreads.map((thread) => thread.threadId));
      nextThreadMetadataList = [...threadMetadataList];
      for (const threadId of threadIdSet) {
        const currentIndex = nextThreadMetadataList.findIndex((entry) => entry.threadId === threadId);
        const current = currentIndex >= 0 ? nextThreadMetadataList[currentIndex] : null;
        const nextThread: StoredThreadMetadata = {
          providerProfileId: current?.providerProfileId ?? 'openai-default',
          threadId,
          alias: current?.alias ?? null,
          archivedAt: now,
          pinnedAt: current?.pinnedAt ?? null,
          deletedAt: current?.deletedAt ?? null,
          updatedAt: now,
        };
        if (currentIndex >= 0) {
          nextThreadMetadataList[currentIndex] = nextThread;
        } else {
          nextThreadMetadataList.push(nextThread);
        }
      }
    }
  }

  fs.writeFileSync(
    path.join(runtimeDir, 'folder_metadata.json'),
    JSON.stringify(nextFolderMetadataList, null, 2),
    'utf8',
  );
  clearRuntimeJsonCache('folder_metadata.json');

  if (nextThreadMetadataList !== threadMetadataList) {
    fs.writeFileSync(
      path.join(runtimeDir, 'thread_metadata.json'),
      JSON.stringify(nextThreadMetadataList, null, 2),
      'utf8',
    );
    clearRuntimeJsonCache('thread_metadata.json');
  }

  return NextResponse.json({
    ok: true,
    cwd,
    metadata: {
      label: nextFolder.alias ?? null,
      isPinned: typeof nextFolder.pinnedAt === 'number',
      isRemoved: typeof nextFolder.removedAt === 'number',
      archivedThreads: action === 'archive',
    },
  });
}
