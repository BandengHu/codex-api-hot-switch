import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssistantRecordService } from '../../src/core/assistant_record_service.js';
import {
  AssistantRecordTodoSourceAdapter,
  createAssistantRecordTodoSourceSummary,
} from '../../src/core/assistant_record_todo_source_adapter.js';
import { InMemoryAssistantRecordRepository } from '../../src/store/in_memory/in_memory_assistant_record_repository.js';
import type { AssistantRecord } from '../../src/types/core.js';

function createAdapter(now = 1_706_200_000_000) {
  const repo = new InMemoryAssistantRecordRepository();
  const service = new AssistantRecordService({
    assistantRecords: repo,
    attachmentRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-record-source-')),
    now: () => now,
    timezone: 'Etc/UTC',
  });
  const adapter = new AssistantRecordTodoSourceAdapter({
    assistantRecords: service,
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-local-todo-source',
    },
    contextThreadId: 'thread-local-todo',
    timezone: 'Etc/UTC',
  });
  return {
    repo,
    service,
    adapter,
  };
}

test('AssistantRecordTodoSourceAdapter creates, lists, gets, and updates local todo work items', async () => {
  const { repo, adapter } = createAdapter();

  const created = await adapter.createWorkItem({
    source: 'manual',
    sourceRef: 'ignored-by-local-adapter',
    title: '  Ship Mission Control source adapter  ',
    goal: '  Make local todos source-backed missions. ',
    expectedOutput: ' A verified local todo source path. ',
    acceptanceCriteria: [' Adapter exists ', ' ', 'Tests pass'],
    plan: [' Add adapter ', '', 'Run tests'],
    metadata: {
      owner: 'mission-control',
      priority: 'high',
      project: 'mission-control',
      tags: ['bridge', ' mission '],
      dueAt: 1_706_200_864_000,
    },
  });

  assert.equal(created.source, 'local-todo');
  assert.ok(created.sourceRef.length > 0);
  assert.equal(created.goal, 'Make local todos source-backed missions.');
  assert.equal(created.expectedOutput, 'A verified local todo source path.');
  assert.deepEqual(created.acceptanceCriteria, ['Adapter exists', 'Tests pass']);
  assert.deepEqual(created.plan, ['Add adapter', 'Run tests']);
  assert.equal((created.metadata?.assistantRecord as Record<string, unknown>)?.status, 'active');
  assert.equal((created.metadata?.sourceAdapter as Record<string, unknown>)?.kind, 'assistant-record-local-todo');

  const persisted = repo.getById(created.sourceRef);
  assert.equal(persisted?.type, 'todo');
  assert.equal(persisted?.title, 'Ship Mission Control source adapter');
  assert.match(persisted?.content ?? '', /Acceptance criteria:/);
  assert.equal((persisted?.parsedJson?.missionControlLocalTodo as Record<string, unknown>)?.schema, 'codexbridge/mission-control/local-todo/v1');

  const listed = await adapter.listWorkItems({
    status: ['active'],
  });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]?.sourceRef, created.sourceRef);

  const loaded = await adapter.getWorkItem({
    sourceRef: created.sourceRef,
  });
  assert.deepEqual(loaded, created);

  await adapter.updateWorkItem({
    sourceRef: created.sourceRef,
    title: 'Ship the local todo adapter',
    goal: 'Keep Mission Control source-backed.',
    expectedOutput: 'A shipped local adapter.',
    acceptanceCriteria: ['Adapter shipped'],
    plan: ['Merge patch'],
    metadata: {
      owner: 'mission-control',
      priority: 'normal',
      tags: ['mission-control'],
    },
  });

  const updated = await adapter.getWorkItem({
    sourceRef: created.sourceRef,
  });
  assert.equal(updated?.title, 'Ship the local todo adapter');
  assert.equal(updated?.goal, 'Keep Mission Control source-backed.');
  assert.equal(updated?.expectedOutput, 'A shipped local adapter.');
  assert.deepEqual(updated?.acceptanceCriteria, ['Adapter shipped']);
  assert.deepEqual(updated?.plan, ['Merge patch']);
  assert.notEqual(updated?.sourceRevision, created.sourceRevision);
  assert.equal((updated?.metadata?.assistantRecord as Record<string, unknown>)?.priority, 'normal');
});

test('AssistantRecordTodoSourceAdapter falls back to live todo content when structured payload is stale', () => {
  const { repo } = createAdapter();
  const record: AssistantRecord = {
    id: 'assistant-record-stale-1',
    type: 'todo',
    status: 'active',
    title: 'Review runtime loops',
    content: 'Re-read the live todo content after a manual edit.',
    originalText: 'Review runtime loops',
    priority: 'normal',
    project: null,
    tags: [],
    dueAt: null,
    remindAt: null,
    recurrence: null,
    timezone: 'Etc/UTC',
    source: 'manual',
    platform: 'weixin',
    scopeId: 'wx-local-todo-source',
    contextThreadId: null,
    attachments: [],
    parseStatus: 'confirmed',
    confidence: 1,
    parsedJson: {
      missionControlLocalTodo: {
        schema: 'codexbridge/mission-control/local-todo/v1',
        contentDigest: 'stale-digest',
        goal: 'Old structured goal',
        expectedOutput: 'Old structured output',
        acceptanceCriteria: ['Old criteria'],
        plan: ['Old plan'],
        metadata: {
          owner: 'stale',
        },
      },
    },
    lastRemindedAt: null,
    createdAt: 1_706_200_000_000,
    updatedAt: 1_706_200_000_100,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
  };
  repo.save(record);

  const summary = createAssistantRecordTodoSourceSummary(record);
  assert.equal(summary.source, 'local-todo');
  assert.equal(summary.goal, 'Re-read the live todo content after a manual edit.');
  assert.equal(summary.expectedOutput, 'Re-read the live todo content after a manual edit.');
  assert.deepEqual(summary.acceptanceCriteria, []);
  assert.deepEqual(summary.plan, []);
  assert.equal((summary.metadata?.sourceAdapter as Record<string, unknown>)?.contentDigestMatches, false);
});
