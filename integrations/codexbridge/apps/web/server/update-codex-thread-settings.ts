import path from 'node:path';
import { stdin, stdout, stderr } from 'node:process';
import { createCodexBridgeRuntime } from '../../../src/runtime/bootstrap.ts';
import { buildPermissionsSettingsUpdate, normalizePermissionsMode, resolvePermissionsState } from '../../../src/core/permissions_mode.ts';
import { createFileJsonRepositories } from '../../../src/store/file_json/create_file_json_repositories.ts';
import { OpenAINativeProviderPlugin } from '../../../src/providers/openai_native/plugin.ts';
import { OpenAICompatibleProviderPlugin } from '../../../src/providers/openai_compatible/plugin.ts';
import { CodexAccountManager } from '../../../src/providers/codex/account_manager.ts';
import { CodexGoalManager } from '../../../src/providers/codex/goal_state.ts';

type InputPayload = {
  threadId?: unknown;
  permissionsMode?: unknown;
  model?: unknown;
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

function inferNativeProviderProfileId(
  runtime: ReturnType<typeof createCodexBridgeRuntime>,
  threadId: string,
): string {
  const nativeProfiles = runtime.repositories.providerProfiles
    .list()
    .filter((profile) => profile.providerKind === 'openai-native');

  for (const profile of nativeProfiles) {
    if (runtime.services.bridgeSessions.findSessionByProviderThread(profile.id, threadId)) {
      return profile.id;
    }
  }

  return nativeProfiles.find((profile) => profile.id === 'openai-default')?.id
    ?? nativeProfiles[0]?.id
    ?? 'openai-default';
}

function hasOwn(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw || '{}') as InputPayload & Record<string, unknown>;
  const threadId = normalizeText(payload.threadId);
  const permissionsMode = normalizePermissionsMode(payload.permissionsMode);
  const stateDir = normalizeText(payload.stateDir);
  const repoRoot = normalizeText(payload.repoRoot);
  const hasPermissionsMode = hasOwn(payload, 'permissionsMode');
  const hasModel = hasOwn(payload, 'model');
  const hasReasoningEffort = hasOwn(payload, 'reasoningEffort');

  if (!threadId || !stateDir || !repoRoot) {
    throw new Error('invalid_request');
  }
  if (hasPermissionsMode && !permissionsMode) {
    throw new Error('invalid_permissions_mode');
  }

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

  const providerProfileId = inferNativeProviderProfileId(runtime, threadId);
  const providerProfile = repositories.providerProfiles.getById(providerProfileId);
  if (!providerProfile) {
    throw new Error('provider_profile_not_found');
  }
  const providerPlugin = runtime.registry.getProvider(providerProfile.providerKind) as {
    listModels?: (args: { providerProfile: typeof providerProfile }) => Promise<any[]>;
  };
  if (typeof providerPlugin?.listModels !== 'function') {
    throw new Error('models_unsupported');
  }
  const listedModels = await providerPlugin.listModels({ providerProfile });
  const models = Array.isArray(listedModels) ? listedModels : [];

  let session = runtime.services.bridgeSessions.findSessionByProviderThread(providerProfileId, threadId);
  let sessionSettings = session
    ? runtime.services.bridgeSessions.getSessionSettings(session.id)
    : null;
  const nextUpdates: Record<string, unknown> = {};

  if (hasPermissionsMode) {
    Object.assign(nextUpdates, buildPermissionsSettingsUpdate(permissionsMode));
  }

  let matchedModel = null as Awaited<ReturnType<typeof runtime.services.bridgeCoordinator.resolveEffectiveModelState>>['modelInfo'];
  if (hasModel) {
    const rawModel = payload.model;
    const normalizedModel = normalizeText(rawModel);
    if (!normalizedModel) {
      nextUpdates.model = null;
      if (!hasReasoningEffort) {
        nextUpdates.reasoningEffort = null;
      }
    } else {
      matchedModel = runtime.services.bridgeCoordinator.findModelByToken(models, normalizedModel)
        ?? runtime.services.bridgeCoordinator.findModelByIndexToken(models, normalizedModel);
      if (!matchedModel) {
        throw new Error('unknown_model');
      }
      nextUpdates.model = String(matchedModel.model ?? matchedModel.id);
      if (!hasReasoningEffort) {
        const currentEffort = normalizeText(sessionSettings?.reasoningEffort ?? null);
        if (currentEffort && !runtime.services.bridgeCoordinator.resolveEffortForModel(matchedModel, currentEffort)) {
          nextUpdates.reasoningEffort = null;
        }
      }
    }
  }

  if (hasReasoningEffort) {
    const rawEffort = normalizeText(payload.reasoningEffort);
    if (!rawEffort) {
      nextUpdates.reasoningEffort = null;
    } else {
      const previewSettings = {
        ...(sessionSettings ?? {}),
        ...nextUpdates,
      };
      const modelForEffort = runtime.services.bridgeCoordinator.resolveSessionModelForEffort(
        models,
        typeof previewSettings.model === 'string' ? previewSettings.model : null,
      );
      const resolvedEffort = runtime.services.bridgeCoordinator.resolveEffortForModel(
        modelForEffort,
        rawEffort,
      );
      if (!resolvedEffort) {
        throw new Error('unsupported_reasoning_effort');
      }
      nextUpdates.reasoningEffort = resolvedEffort;
    }
  }

  if (Object.keys(nextUpdates).length > 0) {
    session = session
      ?? await runtime.services.bridgeSessions.ensureSessionForProviderThread(
        { providerProfileId, codexThreadId: threadId },
        { initialSettings: nextUpdates },
      );
    runtime.services.bridgeSessions.upsertSessionSettings(session.id, nextUpdates);
    sessionSettings = runtime.services.bridgeSessions.getSessionSettings(session.id);
  }

  const resolved = resolvePermissionsState(
    sessionSettings ?? (hasPermissionsMode ? buildPermissionsSettingsUpdate(permissionsMode) : buildPermissionsSettingsUpdate('default-permissions')),
  );
  const effectiveModelState = await runtime.services.bridgeCoordinator.resolveEffectiveModelState(
    providerProfile,
    sessionSettings,
    models,
  );

  await Promise.allSettled(
    runtime.registry.listProviders<any>().map((plugin) => plugin?.stop?.()),
  );

  stdout.write(`${JSON.stringify({
    ok: true,
    threadId,
    bridgeSessionId: session?.id ?? null,
    model: sessionSettings?.model ?? null,
    reasoningEffort: sessionSettings?.reasoningEffort ?? null,
    serviceTier: sessionSettings?.serviceTier ?? null,
    effectiveModelId: effectiveModelState.modelId,
    effectiveModelLabel: effectiveModelState.modelValue,
    effectiveModelDescription: effectiveModelState.description,
    effectiveModelSource: effectiveModelState.modelSource,
    effectiveReasoningEffort: effectiveModelState.effortValue,
    effectiveReasoningEffortSource: effectiveModelState.effortSource,
    defaultReasoningEffort: effectiveModelState.defaultReasoningEffort,
    availableModels: effectiveModelState.models.map((model) => ({
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description,
      isDefault: model.isDefault,
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : [],
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
    })),
    permissionsMode: resolved.permissionsMode,
    accessPreset: resolved.accessPreset,
    approvalPolicy: resolved.approvalPolicy,
    sandboxMode: resolved.sandboxMode,
    approvalsReviewer: resolved.approvalsReviewer,
    usesProfileDefaults: resolved.usesProfileDefaults,
  })}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  process.exitCode = 1;
});
