import { stdin, stdout, stderr } from 'node:process';
import { executeWebThreadReply } from './reply-executor';

type InputPayload = {
  threadId?: unknown;
  text?: unknown;
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

function emit(event: Record<string, unknown>) {
  stdout.write(`${JSON.stringify(event)}\n`);
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw || '{}') as InputPayload;
  const threadId = normalizeText(payload.threadId);
  const text = normalizeText(payload.text);
  const stateDir = normalizeText(payload.stateDir);
  const repoRoot = normalizeText(payload.repoRoot);

  if (!threadId || !text || !stateDir || !repoRoot) {
    throw new Error('invalid_request');
  }

  const result = await executeWebThreadReply({
    repoRoot,
    stateDir,
    text,
    threadId,
    onAssistantText: async (assistantText) => {
      emit({
        type: 'assistant',
        text: assistantText,
      });
    },
    onCommentaryText: async (commentaryText) => {
      emit({
        type: 'commentary',
        text: commentaryText,
      });
    },
    onTurnStarted: async (meta) => {
      emit({
        type: 'started',
        bridgeSessionId: meta.bridgeSessionId,
        providerProfileId: meta.providerProfileId,
        threadId: meta.threadId,
        turnId: meta.turnId,
      });
    },
  });

  emit({
    type: 'done',
    bridgeSessionId: result.bridgeSessionId,
    outputText: result.outputText,
    threadId: result.threadId,
    items: result.items,
    hasMore: result.hasMore,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  process.exitCode = 1;
});
