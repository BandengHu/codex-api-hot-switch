import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getWebPaths } from '../lib/server/runtime';
import type { WebCodexThreadMessage } from '../lib/server/queries';

type ReplyRunStatus = 'queued' | 'running' | 'completed' | 'failed';

export type ReplyRunSnapshot = {
  runId: string;
  sourceThreadId: string;
  finalThreadId: string | null;
  bridgeSessionId: string | null;
  status: ReplyRunStatus;
  assistantText: string;
  commentaryText: string;
  error: string | null;
  turnId: string | null;
  items: WebCodexThreadMessage[] | null;
  hasMore: boolean;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type ReplyRunEvent =
  | { type: 'snapshot'; run: ReplyRunSnapshot }
  | { type: 'started'; run: ReplyRunSnapshot }
  | { type: 'assistant'; run: ReplyRunSnapshot }
  | { type: 'commentary'; run: ReplyRunSnapshot }
  | { type: 'done'; run: ReplyRunSnapshot }
  | { type: 'failed'; run: ReplyRunSnapshot };

type ReplyRunRecord = {
  snapshot: ReplyRunSnapshot;
  cleanupTimer: NodeJS.Timeout | null;
  listeners: Set<(event: ReplyRunEvent) => void>;
};

const RUN_TTL_MS = 15 * 60 * 1000;

class ReplyRunManager {
  private readonly runs = new Map<string, ReplyRunRecord>();

  createRun({
    text,
    threadId,
  }: {
    text: string;
    threadId: string;
  }): ReplyRunSnapshot {
    const runId = crypto.randomUUID();
    const now = Date.now();
    const snapshot: ReplyRunSnapshot = {
      runId,
      sourceThreadId: threadId,
      finalThreadId: null,
      bridgeSessionId: null,
      status: 'queued',
      assistantText: '',
      commentaryText: '',
      error: null,
      turnId: null,
      items: null,
      hasMore: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    const record: ReplyRunRecord = {
      snapshot,
      cleanupTimer: null,
      listeners: new Set(),
    };
    this.runs.set(runId, record);
    void this.execute(record, text).catch((error) => {
      this.fail(record, error instanceof Error ? error.message : String(error));
    });
    return snapshot;
  }

  getSnapshot(runId: string): ReplyRunSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  subscribe(runId: string, listener: (event: ReplyRunEvent) => void): (() => void) | null {
    const record = this.runs.get(runId);
    if (!record) {
      return null;
    }
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  private emit(record: ReplyRunRecord, type: ReplyRunEvent['type']) {
    const event = {
      type,
      run: { ...record.snapshot },
    } as ReplyRunEvent;
    for (const listener of record.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener failures
      }
    }
  }

  private update(record: ReplyRunRecord, patch: Partial<ReplyRunSnapshot>, eventType: ReplyRunEvent['type']) {
    record.snapshot = {
      ...record.snapshot,
      ...patch,
      updatedAt: Date.now(),
    };
    this.emit(record, eventType);
  }

  private fail(record: ReplyRunRecord, message: string) {
    this.update(record, {
      completedAt: Date.now(),
      error: message || 'reply_failed',
      status: 'failed',
    }, 'failed');
    this.scheduleCleanup(record.snapshot.runId);
  }

  private scheduleCleanup(runId: string) {
    const record = this.runs.get(runId);
    if (!record) {
      return;
    }
    if (record.cleanupTimer) {
      clearTimeout(record.cleanupTimer);
    }
    record.cleanupTimer = setTimeout(() => {
      this.runs.delete(runId);
    }, RUN_TTL_MS);
  }

  private async execute(record: ReplyRunRecord, text: string) {
    const { repoRoot, stateDir } = getWebPaths();
    const scriptPath = path.join(process.cwd(), 'server', 'reply-codex-thread.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let completed = false;

    const handleLine = (line: string) => {
      const payload = JSON.parse(line) as
        | {
            type: 'started';
            bridgeSessionId?: string | null;
            providerProfileId?: string | null;
            threadId?: string | null;
            turnId?: string | null;
          }
        | {
            type: 'assistant';
            text?: string | null;
          }
        | {
            type: 'commentary';
            text?: string | null;
          }
        | {
            type: 'done';
            bridgeSessionId?: string | null;
            outputText?: string | null;
            threadId?: string | null;
            items?: WebCodexThreadMessage[] | null;
            hasMore?: boolean | null;
          };

      if (payload.type === 'started') {
        this.update(record, {
          bridgeSessionId: typeof payload.bridgeSessionId === 'string' ? payload.bridgeSessionId : record.snapshot.bridgeSessionId,
          finalThreadId: typeof payload.threadId === 'string' ? payload.threadId : record.snapshot.finalThreadId,
          status: 'running',
          turnId: typeof payload.turnId === 'string' ? payload.turnId : record.snapshot.turnId,
        }, 'started');
        return;
      }

      if (payload.type === 'assistant') {
        this.update(record, {
          assistantText: typeof payload.text === 'string' ? payload.text : record.snapshot.assistantText,
        }, 'assistant');
        return;
      }

      if (payload.type === 'commentary') {
        this.update(record, {
          commentaryText: typeof payload.text === 'string' ? payload.text : record.snapshot.commentaryText,
        }, 'commentary');
        return;
      }

      completed = true;
      this.update(record, {
        assistantText:
          typeof payload.outputText === 'string' && payload.outputText.trim()
            ? payload.outputText
            : record.snapshot.assistantText,
        bridgeSessionId:
          typeof payload.bridgeSessionId === 'string'
            ? payload.bridgeSessionId
            : record.snapshot.bridgeSessionId,
        completedAt: Date.now(),
        error: null,
        finalThreadId:
          typeof payload.threadId === 'string'
            ? payload.threadId
            : record.snapshot.finalThreadId,
        hasMore: Boolean(payload.hasMore),
        items: Array.isArray(payload.items) ? payload.items : record.snapshot.items,
        status: 'completed',
      }, 'done');
      this.scheduleCleanup(record.snapshot.runId);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      while (stdoutBuffer.includes('\n')) {
        const newlineIndex = stdoutBuffer.indexOf('\n');
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        try {
          handleLine(line);
        } catch (error) {
          stderrBuffer += `${error instanceof Error ? error.message : String(error)}\n`;
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk;
    });

    child.stdin.end(JSON.stringify({
      repoRoot,
      stateDir,
      text,
      threadId: record.snapshot.sourceThreadId,
    }));

    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (completed && code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderrBuffer.trim() || `reply_failed:${code ?? 'unknown'}`));
      });
    }).catch((error) => {
      this.fail(record, error instanceof Error ? error.message : String(error));
    });
  }
}

let manager: ReplyRunManager | null = null;

export function getReplyRunManager(): ReplyRunManager {
  if (!manager) {
    manager = new ReplyRunManager();
  }
  return manager;
}
