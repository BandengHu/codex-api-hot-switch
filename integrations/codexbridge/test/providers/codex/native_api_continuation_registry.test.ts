import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCodexNativeApiContinuationRegistry } from '../../../src/providers/codex/native_api_continuation_registry.js';

test('InMemoryCodexNativeApiContinuationRegistry stores, touches, and expires continuation entries', () => {
  let now = 1_000;
  const registry = new InMemoryCodexNativeApiContinuationRegistry({
    now: () => now,
    ttlMs: 250,
  });

  const stored = registry.store({
    responseId: 'resp_1',
    previousResponseId: null,
    providerProfileId: 'openai-default',
    bridgeSession: {
      id: 'session-1',
      providerProfileId: 'openai-default',
      codexThreadId: 'thread-1',
      cwd: '/tmp/native',
      title: 'Native',
      createdAt: now,
      updatedAt: now,
    },
    nativeThreadId: 'thread-1',
    nativeTurnId: 'turn-1',
    activeAccountId: 'acc_native',
    model: 'gpt-5.5',
    routeKind: 'responses',
  });

  assert.equal(stored.expiryAt, 1_250);
  assert.equal(registry.lookup('resp_1').status, 'found');

  now = 1_100;
  const touched = registry.touch('resp_1');
  assert.equal(touched.status, 'found');
  assert.equal(touched.entry?.lastUsedAt, 1_100);
  assert.equal(touched.entry?.expiryAt, 1_350);

  now = 1_351;
  const expired = registry.lookup('resp_1');
  assert.equal(expired.status, 'expired');
  assert.equal(expired.entry, null);
  assert.equal(registry.lookup('resp_1').status, 'missing');
});
