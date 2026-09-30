import { spawn } from 'node:child_process';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getWebPaths } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ threadId: string }> },
) {
  const { threadId } = await context.params;
  if (!threadId) {
    return NextResponse.json({ error: 'threadId is required' }, { status: 400 });
  }

  const scriptPath = path.join(process.cwd(), 'server', 'update-codex-thread-settings.ts');
  const { repoRoot, stateDir } = getWebPaths();

  try {
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
        reject(new Error(stderrData.trim() || `read_thread_model_options_failed:${code}`));
      });

      child.stdin.end(JSON.stringify({
        threadId,
        stateDir,
        repoRoot,
      }));
    });

    const parsed = JSON.parse(result || '{}') as Record<string, unknown>;
    return NextResponse.json(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'model_options_failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
