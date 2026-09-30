import { spawn } from 'node:child_process';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getWebPaths } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const model = searchParams.get('model')?.trim() || '';
  const reasoningEffort = searchParams.get('reasoningEffort')?.trim() || '';
  const scriptPath = path.join(process.cwd(), 'server', 'read-codex-launch-model-options.ts');
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
        reject(new Error(stderrData.trim() || `read_launch_model_options_failed:${code}`));
      });

      child.stdin.end(JSON.stringify({
        model: model || null,
        reasoningEffort: reasoningEffort || null,
        repoRoot,
        stateDir,
      }));
    });

    const parsed = JSON.parse(result || '{}') as Record<string, unknown>;
    return NextResponse.json(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'launch_model_options_failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
