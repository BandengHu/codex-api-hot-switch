import path from 'node:path';
import { stdin, stdout, stderr } from 'node:process';
import { createCodexBridgeRuntime } from '../../../src/runtime/bootstrap.ts';
import { buildPermissionsSettingsUpdate, normalizePermissionsMode } from '../../../src/core/permissions_mode.ts';
import { createFileJsonRepositories } from '../../../src/store/file_json/create_file_json_repositories.ts';
import { OpenAINativeProviderPlugin } from '../../../src/providers/openai_native/plugin.ts';
import { OpenAICompatibleProviderPlugin } from '../../../src/providers/openai_compatible/plugin.ts';
import { CodexAccountManager } from '../../../src/providers/codex/account_manager.ts';
import { CodexGoalManager } from '../../../src/providers/codex/goal_state.ts';

type InputPayload = {
  cwd?: unknown;
  model?: unknown;
  permissionsMode?: unknown;
  reasoningEffort?: unknown;
  stateDir?: unknown;
  repoRoot?: unknown;
};

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

function resolveNativeProviderProfileId(
  runtime: ReturnType<typeof createCodexBridgeRuntime>,
): string {
  const nativeProfiles = runtime.repositories.providerProfiles
    .list()
    .filter((profile) => profile.providerKind === 'openai-native');

  return nativeProfiles.find((profile) => profile.id === 'openai-default')?.id
    ?? nativeProfiles[0]?.id
    ?? 'openai-default';
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw || '{}') as InputPayload;
  const cwd = normalizeText(payload.cwd);
  const model = normalizeText(payload.model);
  const permissionsMode = normalizePermissionsMode(payload.permissionsMode);
  const reasoningEffort = normalizeText(payload.reasoningEffort);
  const stateDir = normalizeText(payload.stateDir);
  const repoRoot = normalizeText(payload.repoRoot);

  if (!stateDir || !repoRoot) {
    throw new Error('invalid_request');
  }
  const targetCwd = cwd || repoRoot;

  const runtimeDir = path.join(stateDir, 'runtime');
  const repositories = createFileJsonRepositories(runtimeDir);
  const providerProfiles = repositories.providerProfiles.list();
  const defaultProviderProfileId = providerProfiles.some((profile) => profile.id === 'openai-default')
    ? 'openai-default'
    : (providerProfiles[0]?.id ?? null);

  const runtime = createCodexBridgeRuntime({
    providerPlugins: [
      new OpenAINativeProviderPlugin(),
      new OpenAICompatibleProviderPlugin(),
    ],
    providerProfiles,
    defaultProviderProfileId,
    defaultCwd: process.env.CODEXBRIDGE_DEFAULT_CWD ?? repoRoot,
    locale: 'zh-CN',
    repositories,
    assistantAttachmentRoot: path.join(stateDir, 'assistant', 'attachments'),
    codexAuthManager: new CodexAccountManager({
      rootDir: path.join(stateDir, 'runtime', 'codex-login'),
    }),
    codexGoalManager: new CodexGoalManager({
      filePath: path.join(stateDir, 'runtime', 'codex-goal.txt'),
    }),
  });

  const providerProfileId = resolveNativeProviderProfileId(runtime);
  const initialSettings = {
    ...(permissionsMode ? buildPermissionsSettingsUpdate(permissionsMode) : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
  const session = await runtime.services.bridgeSessions.createDetachedSession({
    providerProfileId,
    cwd: targetCwd,
    initialSettings,
    title: null,
  });

  await Promise.allSettled(
    runtime.registry.listProviders<any>().map((plugin) => plugin?.stop?.()),
  );

  stdout.write(`${JSON.stringify({
    ok: true,
    threadId: session.codexThreadId,
    bridgeSessionId: session.id,
    cwd: session.cwd ?? targetCwd,
    title: session.title,
  })}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  process.exitCode = 1;
});
