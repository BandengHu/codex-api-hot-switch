import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMissionVerifierResultToChecklistSnapshot,
  createMission,
  createMissionChecklistSnapshot,
  createMissionCycleResult,
  createMissionVerifierResult,
  getLatestMissionCycleResult,
  listMissionCycleResults,
  summarizeChecklistSnapshotProgress,
  transitionMission,
} from '../src/index.js';
import type { MissionEvent } from '../src/index.js';

function createQueuedMission(now = 1_702_000_000_000) {
  return transitionMission(createMission({
    id: 'mission-cycle-1',
    source: 'manual',
    platform: 'weixin',
    externalScopeId: 'wx-cycle-1',
    title: 'Track checklist progress',
    goal: 'Track mission cycle progress with checklist-aware summaries.',
    expectedOutput: '',
    acceptanceCriteria: ['Patch exists', 'Tests prove the fix'],
    plan: [],
    providerProfileId: 'codex-default',
    now,
  }), 'queued', {
    at: now + 10,
    reason: 'Mission queued.',
  });
}

test('checklist progress helpers update acceptance items from verifier feedback', () => {
  const mission = createQueuedMission();
  const snapshot = createMissionChecklistSnapshot(mission, {
    at: mission.updatedAt,
    generationId: mission.activeGenerationId,
  });
  const repairResult = createMissionVerifierResult({
    verdict: 'repair',
    summary: 'Patch exists, but test evidence is still missing.',
    missingAcceptanceCriteria: ['Tests prove the fix'],
  });

  const repaired = applyMissionVerifierResultToChecklistSnapshot(snapshot, repairResult, mission.updatedAt + 100);
  assert.equal(repaired.items.find((item) => item.title === 'Patch exists')?.status, 'completed');
  assert.equal(repaired.items.find((item) => item.title === 'Tests prove the fix')?.status, 'pending');
  assert.deepEqual(summarizeChecklistSnapshotProgress(repaired), {
    overallCompletion: 50,
    activeItemId: repaired.items.find((item) => item.title === 'Tests prove the fix')?.id ?? null,
    activeItemStatus: 'pending',
    completedItemCount: 1,
    totalItemCount: 2,
  });

  const completed = applyMissionVerifierResultToChecklistSnapshot(repaired, createMissionVerifierResult({
    verdict: 'complete',
    summary: 'All acceptance criteria passed.',
  }), mission.updatedAt + 200);
  assert.equal(completed.items.every((item) => item.status === 'completed'), true);
  assert.equal(summarizeChecklistSnapshotProgress(completed).overallCompletion, 100);
  assert.equal(summarizeChecklistSnapshotProgress(completed).activeItemId, null);
});

test('cycle result helpers create typed cycle records and read them back from mission events', () => {
  const mission = createQueuedMission(1_702_000_100_000);
  const snapshot = createMissionChecklistSnapshot(mission, {
    at: mission.updatedAt,
    generationId: mission.activeGenerationId,
  });
  const updatedSnapshot = applyMissionVerifierResultToChecklistSnapshot(snapshot, createMissionVerifierResult({
    verdict: 'repair',
    summary: 'Tests still need to run.',
    missingAcceptanceCriteria: ['Tests prove the fix'],
  }), mission.updatedAt + 100);

  const firstCycle = createMissionCycleResult({
    mission,
    attempt: null,
    checklistSnapshot: updatedSnapshot,
    cycle: 1,
    status: 'retry',
    stage: 'verifier.repair',
    progress: 'Tests still need to run.',
    nextStep: 'Render a repair prompt and retry.',
    verifierSummary: 'Tests still need to run.',
    blocker: 'Tests still need to run.',
    evidence: {
      missingAcceptanceCriteria: ['Tests prove the fix'],
    },
    eventSeq: 3,
    updatedAt: mission.updatedAt + 100,
  });
  const secondCycle = createMissionCycleResult({
    mission,
    attempt: null,
    checklistSnapshot: snapshot,
    cycle: 2,
    status: 'done',
    stage: 'verifier.complete',
    progress: 'Acceptance criteria satisfied.',
    verifierSummary: 'Acceptance criteria satisfied.',
    evidence: {
      verdict: 'complete',
    },
    eventSeq: 4,
    updatedAt: mission.updatedAt + 200,
  });

  const events: MissionEvent[] = [
    {
      id: 'event-cycle-1',
      missionId: mission.id,
      attemptId: null,
      kind: 'mission.retrying',
      summary: firstCycle.progress,
      detail: null,
      metadata: {
        cycleResult: firstCycle,
      },
      createdAt: mission.updatedAt + 100,
    },
    {
      id: 'event-cycle-2',
      missionId: mission.id,
      attemptId: null,
      kind: 'mission.completed',
      summary: secondCycle.progress,
      detail: null,
      metadata: {
        cycleResult: secondCycle,
      },
      createdAt: mission.updatedAt + 200,
    },
  ];

  const cycleResults = listMissionCycleResults(events);
  assert.equal(cycleResults.length, 2);
  assert.equal(cycleResults[0]?.status, 'retry');
  assert.equal(cycleResults[0]?.overallCompletion, 50);
  assert.equal(cycleResults[1]?.status, 'done');
  assert.equal(cycleResults[1]?.overallCompletion, 100);
  assert.equal(getLatestMissionCycleResult(events)?.audit.eventSeq, 4);
});
