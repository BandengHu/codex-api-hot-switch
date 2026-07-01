import { spawn } from 'node:child_process';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getWebCodexThreadSettings, clearWebQueryCaches } from '@/lib/server/queries';
import { clearRuntimeJsonCache, getWebPaths } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  if (!threadId) {
    return NextResponse.json({ error: 'threadId is required' }, { status: 400 });
  }
  const settings = await getWebCodexThreadSettings(threadId);
  if (!settings) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(settings);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  const payload = await request.json().catch(() => null) as {
    permissionsMode?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
  } | null;
  const permissionsMode = typeof payload?.permissionsMode === 'string' ? payload.permissionsMode.trim() : '';
  const hasModel = Boolean(payload) && Object.prototype.hasOwnProperty.call(payload, 'model');
  const hasReasoningEffort = Boolean(payload) && Object.prototype.hasOwnProperty.call(payload, 'reasoningEffort');
  const model = hasModel ? payload?.model ?? null : undefined;
  const reasoningEffort = hasReasoningEffort ? payload?.reasoningEffort ?? null : undefined;
  if (!threadId || (!permissionsMode && !hasModel && !hasReasoningEffort)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const scriptPath = path.join(process.cwd(), 'server', 'update-codex-thread-settings.ts');
  const { repoRoot, stateDir } = getWebPaths();

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
      reject(new Error(stderrData.trim() || `update_thread_settings_failed:${code}`));
    });

    child.stdin.end(JSON.stringify({
      threadId,
      ...(permissionsMode ? { permissionsMode } : {}),
      ...(hasModel ? { model } : {}),
      ...(hasReasoningEffort ? { reasoningEffort } : {}),
      stateDir,
      repoRoot,
    }));
  });

  clearRuntimeJsonCache('session_settings.json');
  clearRuntimeJsonCache('bridge_sessions.json');
  clearRuntimeJsonCache('platform_bindings.json');
  clearWebQueryCaches();

  const parsed = JSON.parse(result || '{}') as Record<string, unknown>;
  return NextResponse.json(parsed);
}
