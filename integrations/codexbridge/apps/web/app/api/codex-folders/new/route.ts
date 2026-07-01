import { spawn } from 'node:child_process';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { clearWebQueryCaches } from '@/lib/server/queries';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const payload = await request.json().catch(() => null) as {
    cwd?: unknown;
    model?: unknown;
    permissionsMode?: unknown;
    reasoningEffort?: unknown;
  } | null;
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : '';
  const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
  const permissionsMode = typeof payload?.permissionsMode === 'string' ? payload.permissionsMode.trim() : '';
  const reasoningEffort = typeof payload?.reasoningEffort === 'string' ? payload.reasoningEffort.trim() : '';

  const scriptPath = path.join(process.cwd(), 'server', 'create-codex-thread.ts');
  const repoRoot = path.resolve(process.cwd(), '..', '..');
  const stateDir = process.env.CODEXBRIDGE_STATE_DIR ?? path.join(process.env.HOME ?? '', '.codexbridge');

  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutData = '';
    let stderrData = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutData += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderrData += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdoutData);
        return;
      }
      reject(new Error(stderrData.trim() || `create_thread_failed:${code}`));
    });

    child.stdin.end(JSON.stringify({
      cwd: cwd || null,
      model: model || null,
      permissionsMode: permissionsMode || null,
      reasoningEffort: reasoningEffort || null,
      stateDir,
      repoRoot,
    }));
  });

  const parsed = JSON.parse(result || '{}') as {
    ok?: boolean;
    threadId?: string;
    bridgeSessionId?: string;
    cwd?: string | null;
    title?: string | null;
  };

  clearWebQueryCaches();

  return NextResponse.json(parsed);
}
