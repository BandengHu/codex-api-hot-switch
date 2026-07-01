import {
  createMissionChecklistSnapshot,
  createMissionGeneration,
  createMissionWorkItem,
} from './domain_records.js';
import { createMission, transitionMission } from './state_machine.js';
import type {
  ChecklistSnapshot,
  Mission,
  MissionGeneration,
  MissionLoopPolicy,
  MissionPriority,
  MissionRiskLevel,
  WorkItem,
} from './types.js';
import type { WorkItemSourceSummary } from './source.js';

export interface CreateMissionAggregateFromSourceSummaryInput {
  missionId: string;
  workItem: WorkItemSourceSummary;
  platform: string;
  externalScopeId: string;
  providerProfileId: string;
  loopPolicy?: Partial<MissionLoopPolicy> | null;
  priority?: MissionPriority;
  riskLevel?: MissionRiskLevel;
  cwd?: string | null;
  workspacePath?: string | null;
  workflowPath?: string | null;
  bridgeSessionId?: string | null;
  codexThreadId?: string | null;
  immutableGoal?: string | null;
  immutablePrompt?: string | null;
  maxAttempts?: number | null;
  maxTurns?: number | null;
  initialStatus?: 'draft' | 'queued';
  reason?: string | null;
  now?: number;
}

export interface MissionAggregateFromSourceSummary {
  mission: Mission;
  workItem: WorkItem;
  generation: MissionGeneration;
  checklistSnapshot: ChecklistSnapshot;
}

export function createMissionAggregateFromSourceSummary(
  input: CreateMissionAggregateFromSourceSummaryInput,
): MissionAggregateFromSourceSummary {
  const at = input.now ?? Date.now();
  const goal = normalizeText(input.workItem.goal) ?? input.workItem.title;
  const expectedOutput = normalizeText(input.workItem.expectedOutput) ?? goal;
  const acceptanceCriteria = input.workItem.acceptanceCriteria.length > 0
    ? [...input.workItem.acceptanceCriteria]
    : [expectedOutput];
  const plan = [...input.workItem.plan];
  let mission = createMission({
    id: input.missionId,
    source: input.workItem.source,
    sourceRef: input.workItem.sourceRef,
    platform: input.platform,
    externalScopeId: input.externalScopeId,
    title: input.workItem.title,
    immutableGoal: normalizeText(input.immutableGoal) ?? goal,
    immutablePrompt: normalizeText(input.immutablePrompt),
    goal,
    expectedOutput,
    acceptanceCriteria,
    plan,
    loopPolicy: input.loopPolicy,
    priority: input.priority,
    riskLevel: input.riskLevel,
    cwd: input.cwd,
    workspacePath: input.workspacePath,
    workflowPath: input.workflowPath,
    providerProfileId: input.providerProfileId,
    bridgeSessionId: input.bridgeSessionId,
    codexThreadId: input.codexThreadId,
    maxAttempts: input.maxAttempts ?? undefined,
    maxTurns: input.maxTurns ?? undefined,
    now: at,
  });
  if ((input.initialStatus ?? 'queued') === 'queued') {
    mission = transitionMission(mission, 'queued', {
      at,
      reason: normalizeText(input.reason) ?? 'Mission queued from a source-backed work item.',
    });
  }
  return {
    mission,
    workItem: createMissionWorkItem(mission, {
      at,
      sourceRevision: input.workItem.sourceRevision,
      metadata: input.workItem.metadata,
    }),
    generation: createMissionGeneration(mission, {
      at,
      trigger: 'initial',
    }),
    checklistSnapshot: createMissionChecklistSnapshot(mission, {
      at,
      generationId: mission.activeGenerationId,
      sourceRevision: input.workItem.sourceRevision,
    }),
  };
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
