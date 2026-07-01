import path from 'node:path';
import { createCodexBridgeRuntime } from '../../../src/runtime/bootstrap.ts';
import { createFileJsonRepositories } from '../../../src/store/file_json/create_file_json_repositories.ts';
import { OpenAINativeProviderPlugin } from '../../../src/providers/openai_native/plugin.ts';
import { OpenAICompatibleProviderPlugin } from '../../../src/providers/openai_compatible/plugin.ts';
import { CodexAccountManager } from '../../../src/providers/codex/account_manager.ts';
import { CodexGoalManager } from '../../../src/providers/codex/goal_state.ts';
import {
  clearWebQueryCaches,
  getWebCodexThreadRecentMessages,
  type WebCodexThreadMessage,
} from '../lib/server/queries';
import { clearRuntimeJsonCache } from '../lib/server/runtime';

type CoordinatorResponseLike = {
  messages?: Array<{ text?: string | null }> | null;
  meta?: {
    codexTurn?: {
      outputState?: string | null;
      errorMessage?: string | null;
    } | null;
  } | null;
  session?: {
    codexThreadId?: string | null;
  } | null;
};

export type WebReplyExecutionResult = {
  bridgeSessionId: string;
  outputText: string;
  threadId: string;
  items: WebCodexThreadMessage[];
  hasMore: boolean;
};

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeCommentaryText(value: unknown): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }
  return normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      if (/^<.*>$/u.test(line)) {
        return false;
      }
      if (/^(the user\b|user\b|i should\b|i need to\b|need to\b|let me\b|we need to\b|we should\b|thinking\b|analysis\b)/iu.test(line)) {
        return false;
      }
      return true;
    })
    .join('\n')
    .trim();
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

function extractResponseText(response: {
  messages?: Array<{ text?: string | null }> | null;
} | null | undefined): string {
  if (!Array.isArray(response?.messages)) {
    return '';
  }
  return response.messages
    .map((message) => normalizeText(message?.text))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export async function executeWebThreadReply({
  onApprovalRequest = null,
  onAssistantText = null,
  onCommentaryText = null,
  onTurnStarted = null,
  repoRoot,
  stateDir,
  text,
  threadId,
}: {
  onApprovalRequest?: ((request: { requestId?: string | null }) => Promise<void> | void) | null;
  onAssistantText?: ((text: string) => Promise<void> | void) | null;
  onCommentaryText?: ((text: string) => Promise<void> | void) | null;
  onTurnStarted?: ((meta: {
    bridgeSessionId: string;
    providerProfileId: string;
    threadId: string | null;
    turnId: string | null;
  }) => Promise<void> | void) | null;
  repoRoot: string;
  stateDir: string;
  text: string;
  threadId: string;
}): Promise<WebReplyExecutionResult> {
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

  try {
    const providerProfileId = inferNativeProviderProfileId(runtime, threadId);
    const scopeRef = {
      platform: 'web',
      externalScopeId: `codex-thread:${threadId}`,
    };
    const session = await runtime.services.bridgeSessions.bindScopeToProviderThread(
      scopeRef,
      { providerProfileId, codexThreadId: threadId },
    );

    let lastAssistantText = '';
    let lastCommentaryText = '';
    const response = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: scopeRef.platform,
      externalScopeId: scopeRef.externalScopeId,
      text,
      cwd: session.cwd ?? null,
      locale: 'zh-CN',
      metadata: {
        codexbridge: {
          overrideBridgeSessionId: session.id,
        },
      },
    }, {
      onApprovalRequest: async (request: { requestId?: string | null }) => {
        if (typeof onApprovalRequest === 'function') {
          await onApprovalRequest(request);
        }
      },
      onProgress: async (progress) => {
        if (progress?.outputKind === 'commentary') {
          const commentaryText = sanitizeCommentaryText(progress.text);
          if (!commentaryText || commentaryText === lastCommentaryText) {
            return;
          }
          lastCommentaryText = commentaryText;
          if (typeof onCommentaryText === 'function') {
            await onCommentaryText(commentaryText);
          }
          return;
        }
        if (progress?.outputKind !== 'final_answer') {
          return;
        }
        const nextText = normalizeText(progress.text);
        if (!nextText || nextText === lastAssistantText) {
          return;
        }
        lastAssistantText = nextText;
        if (typeof onAssistantText === 'function') {
          await onAssistantText(nextText);
        }
      },
      onTurnStarted: async (meta: {
        bridgeSessionId: string;
        providerProfileId: string;
        threadId: string | null;
        turnId: string | null;
      }) => {
        if (typeof onTurnStarted === 'function') {
          await onTurnStarted(meta);
        }
      },
    });

    const typedResponse = response as CoordinatorResponseLike;
    const outputState = normalizeText(typedResponse.meta?.codexTurn?.outputState);
    const codexErrorMessage = normalizeText(typedResponse.meta?.codexTurn?.errorMessage);
    const responseText = extractResponseText(typedResponse) || lastAssistantText;
    if (
      outputState === 'stale_session'
      || outputState === 'provider_error'
      || (!responseText && codexErrorMessage)
    ) {
      throw new Error(codexErrorMessage || 'reply_failed');
    }

    const reboundThreadId =
      normalizeText(typedResponse.session?.codexThreadId)
      || threadId;

    clearWebQueryCaches();
    clearRuntimeJsonCache();
    const recent = await getWebCodexThreadRecentMessages(reboundThreadId, 8);

    return {
      bridgeSessionId: session.id,
      outputText: responseText,
      threadId: reboundThreadId,
      items: recent.items,
      hasMore: recent.hasMore,
    };
  } finally {
    await Promise.allSettled(
      runtime.registry.listProviders<any>().map((plugin) => plugin?.stop?.()),
    );
  }
}
