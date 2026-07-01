import {
  hashChecklistSnapshot,
  normalizeMissionRecord,
  normalizeWorkflowHash,
  normalizeWorkflowResolverReason,
} from './domain_records.js';
import { isMissionResumable } from './state_machine.js';
import type { MissionRepository } from './repository.js';
import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionCheckpoint,
  MissionEnvironmentStamp,
  MissionEvent,
  MissionGeneration,
  PlanChangeRequest,
  WorkItem,
} from './types.js';

type InMemoryState = {
  workItems: WorkItem[];
  missions: Mission[];
  generations: MissionGeneration[];
  checklistSnapshots: ChecklistSnapshot[];
  planChangeRequests: PlanChangeRequest[];
  attempts: MissionAttempt[];
  environmentStamps: MissionEnvironmentStamp[];
  checkpoints: MissionCheckpoint[];
  events: MissionEvent[];
};

const DEFAULT_STATE: InMemoryState = {
  workItems: [],
  missions: [],
  generations: [],
  checklistSnapshots: [],
  planChangeRequests: [],
  attempts: [],
  environmentStamps: [],
  checkpoints: [],
  events: [],
};

export class InMemoryMissionRepository implements MissionRepository {
  private state: InMemoryState;

  constructor(seedState: Partial<InMemoryState> = {}) {
    this.state = normalizeState({
      ...DEFAULT_STATE,
      ...cloneValue(seedState),
    });
  }

  getWorkItemById(id: string): WorkItem | null {
    return this.state.workItems.find((workItem) => workItem.id === id) ?? null;
  }

  saveWorkItem(workItem: WorkItem): WorkItem {
    this.state.workItems = upsertById(this.state.workItems, workItem);
    return cloneValue(workItem);
  }

  getMissionById(id: string): Mission | null {
    return this.state.missions.find((mission) => mission.id === id) ?? null;
  }

  listMissions(): Mission[] {
    return cloneValue(this.state.missions);
  }

  listResumableMissions(now = Date.now()): Mission[] {
    return this.state.missions
      .filter((mission) => isMissionResumable(mission, now))
      .map((mission) => cloneValue(mission));
  }

  saveMission(mission: Mission): Mission {
    this.state.missions = upsertById(this.state.missions, mission);
    return cloneValue(mission);
  }

  resetMission(mission: Mission): Mission {
    this.state.workItems = this.state.workItems.filter((workItem) => workItem.id !== mission.workItemId);
    this.state.missions = upsertById(this.state.missions, mission);
    this.state.generations = this.state.generations.filter((generation) => generation.missionId !== mission.id);
    this.state.checklistSnapshots = this.state.checklistSnapshots.filter((snapshot) => snapshot.missionId !== mission.id);
    this.state.planChangeRequests = this.state.planChangeRequests.filter((changeRequest) => changeRequest.missionId !== mission.id);
    this.state.attempts = this.state.attempts.filter((attempt) => attempt.missionId !== mission.id);
    this.state.environmentStamps = this.state.environmentStamps.filter((stamp) => stamp.missionId !== mission.id);
    this.state.checkpoints = this.state.checkpoints.filter((checkpoint) => checkpoint.missionId !== mission.id);
    this.state.events = this.state.events.filter((event) => event.missionId !== mission.id);
    return cloneValue(mission);
  }

  getGenerationById(id: string): MissionGeneration | null {
    return this.state.generations.find((generation) => generation.id === id) ?? null;
  }

  listGenerations(missionId: string): MissionGeneration[] {
    return this.state.generations
      .filter((generation) => generation.missionId === missionId)
      .map((generation) => cloneValue(generation));
  }

  saveGeneration(generation: MissionGeneration): MissionGeneration {
    this.state.generations = upsertById(this.state.generations, generation);
    return cloneValue(generation);
  }

  getChecklistSnapshotById(id: string): ChecklistSnapshot | null {
    return this.state.checklistSnapshots.find((snapshot) => snapshot.id === id) ?? null;
  }

  listChecklistSnapshots(missionId: string): ChecklistSnapshot[] {
    return this.state.checklistSnapshots
      .filter((snapshot) => snapshot.missionId === missionId)
      .map((snapshot) => cloneValue(snapshot));
  }

  saveChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot {
    this.state.checklistSnapshots = upsertById(this.state.checklistSnapshots, snapshot);
    return cloneValue(snapshot);
  }

  getPlanChangeRequestById(id: string): PlanChangeRequest | null {
    return this.state.planChangeRequests.find((changeRequest) => changeRequest.id === id) ?? null;
  }

  listPlanChangeRequests(missionId: string): PlanChangeRequest[] {
    return this.state.planChangeRequests
      .filter((changeRequest) => changeRequest.missionId === missionId)
      .map((changeRequest) => cloneValue(changeRequest));
  }

  savePlanChangeRequest(changeRequest: PlanChangeRequest): PlanChangeRequest {
    this.state.planChangeRequests = upsertById(this.state.planChangeRequests, changeRequest);
    return cloneValue(changeRequest);
  }

  getAttemptById(id: string): MissionAttempt | null {
    return this.state.attempts.find((attempt) => attempt.id === id) ?? null;
  }

  listAttempts(missionId: string): MissionAttempt[] {
    return this.state.attempts
      .filter((attempt) => attempt.missionId === missionId)
      .map((attempt) => cloneValue(attempt));
  }

  saveAttempt(attempt: MissionAttempt): MissionAttempt {
    this.state.attempts = upsertById(this.state.attempts, attempt);
    return cloneValue(attempt);
  }

  getEnvironmentStampById(id: string): MissionEnvironmentStamp | null {
    return this.state.environmentStamps.find((stamp) => stamp.id === id) ?? null;
  }

  listEnvironmentStamps(missionId: string): MissionEnvironmentStamp[] {
    return this.state.environmentStamps
      .filter((stamp) => stamp.missionId === missionId)
      .map((stamp) => cloneValue(stamp));
  }

  saveEnvironmentStamp(stamp: MissionEnvironmentStamp): MissionEnvironmentStamp {
    this.state.environmentStamps = upsertById(this.state.environmentStamps, stamp);
    return cloneValue(stamp);
  }

  getCheckpointById(id: string): MissionCheckpoint | null {
    return this.state.checkpoints.find((checkpoint) => checkpoint.id === id) ?? null;
  }

  listCheckpoints(missionId: string): MissionCheckpoint[] {
    return this.state.checkpoints
      .filter((checkpoint) => checkpoint.missionId === missionId)
      .map((checkpoint) => cloneValue(checkpoint));
  }

  saveCheckpoint(checkpoint: MissionCheckpoint): MissionCheckpoint {
    this.state.checkpoints = upsertById(this.state.checkpoints, checkpoint);
    return cloneValue(checkpoint);
  }

  listEvents(missionId: string): MissionEvent[] {
    return this.state.events
      .filter((event) => event.missionId === missionId)
      .map((event) => cloneValue(event));
  }

  appendEvent(event: MissionEvent): MissionEvent {
    this.state.events = [...this.state.events, cloneValue(event)];
    return cloneValue(event);
  }
}

function normalizeState(state: InMemoryState): InMemoryState {
  return {
    workItems: Array.isArray(state.workItems)
      ? state.workItems.map((workItem) => normalizeWorkItem(cloneValue(workItem)))
      : [],
    missions: Array.isArray(state.missions)
      ? state.missions.map((mission) => normalizeMissionRecord(cloneValue(mission)))
      : [],
    generations: Array.isArray(state.generations)
      ? state.generations.map((generation) => normalizeGeneration(cloneValue(generation)))
      : [],
    checklistSnapshots: Array.isArray(state.checklistSnapshots)
      ? state.checklistSnapshots.map((snapshot) => normalizeChecklistSnapshot(cloneValue(snapshot)))
      : [],
    planChangeRequests: Array.isArray(state.planChangeRequests) ? cloneValue(state.planChangeRequests) : [],
    attempts: Array.isArray(state.attempts)
      ? state.attempts.map((attempt) => normalizeAttempt(cloneValue(attempt)))
      : [],
    environmentStamps: Array.isArray(state.environmentStamps)
      ? state.environmentStamps.map((stamp) => normalizeEnvironmentStamp(cloneValue(stamp)))
      : [],
    checkpoints: Array.isArray(state.checkpoints)
      ? state.checkpoints.map((checkpoint) => normalizeCheckpoint(cloneValue(checkpoint)))
      : [],
    events: Array.isArray(state.events) ? cloneValue(state.events) : [],
  };
}

function normalizeWorkItem(workItem: WorkItem): WorkItem {
  return {
    ...workItem,
    sourceRef: typeof workItem.sourceRef === 'string' ? workItem.sourceRef : null,
    sourceRevision: typeof workItem.sourceRevision === 'string' ? workItem.sourceRevision : null,
    metadata: isRecord(workItem.metadata) ? cloneValue(workItem.metadata) : null,
  };
}

function normalizeChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot {
  const normalized: ChecklistSnapshot = {
    ...snapshot,
    generationId: typeof snapshot.generationId === 'string' ? snapshot.generationId : null,
    sourceRef: typeof snapshot.sourceRef === 'string' ? snapshot.sourceRef : null,
    sourceRevision: typeof snapshot.sourceRevision === 'string' ? snapshot.sourceRevision : null,
    expectedOutput: typeof snapshot.expectedOutput === 'string' ? snapshot.expectedOutput : null,
    acceptanceCriteria: Array.isArray(snapshot.acceptanceCriteria) ? [...snapshot.acceptanceCriteria] : [],
    plan: Array.isArray(snapshot.plan) ? [...snapshot.plan] : [],
    items: Array.isArray(snapshot.items)
      ? snapshot.items.map((item) => ({
        ...item,
        detail: typeof item.detail === 'string' ? item.detail : null,
        sourceRef: typeof item.sourceRef === 'string' ? item.sourceRef : null,
        completionSummary: typeof item.completionSummary === 'string' ? item.completionSummary : null,
      }))
      : [],
  };
  return {
    ...normalized,
    hash: typeof snapshot.hash === 'string' && snapshot.hash.trim().length > 0
      ? snapshot.hash
      : hashChecklistSnapshot(normalized),
  };
}

function normalizeGeneration(generation: MissionGeneration): MissionGeneration {
  return {
    ...generation,
    checklistSnapshotId: typeof generation.checklistSnapshotId === 'string'
      ? generation.checklistSnapshotId
      : null,
    parentGenerationId: typeof generation.parentGenerationId === 'string'
      ? generation.parentGenerationId
      : null,
    workflowPath: typeof generation.workflowPath === 'string' ? generation.workflowPath : null,
    workflowHash: normalizeWorkflowHash(generation.workflowHash),
    resolverReason: normalizeWorkflowResolverReason(generation.resolverReason),
    summary: typeof generation.summary === 'string' ? generation.summary : null,
  };
}

function normalizeAttempt(attempt: MissionAttempt): MissionAttempt {
  return {
    ...attempt,
    missingAcceptanceCriteria: Array.isArray(attempt.missingAcceptanceCriteria)
      ? [...attempt.missingAcceptanceCriteria]
      : [],
    generationId: typeof attempt.generationId === 'string' ? attempt.generationId : null,
    generationIndex: normalizePositiveInteger(attempt.generationIndex),
    checklistSnapshotId: typeof attempt.checklistSnapshotId === 'string' ? attempt.checklistSnapshotId : null,
    workflowPath: typeof attempt.workflowPath === 'string' ? attempt.workflowPath : null,
    workflowHash: normalizeWorkflowHash(attempt.workflowHash),
    resolverReason: normalizeWorkflowResolverReason(attempt.resolverReason),
  };
}

function normalizeEnvironmentStamp(stamp: MissionEnvironmentStamp): MissionEnvironmentStamp {
  return {
    ...stamp,
    attemptId: typeof stamp.attemptId === 'string' ? stamp.attemptId : null,
    cwd: typeof stamp.cwd === 'string' ? stamp.cwd : null,
    workspacePath: typeof stamp.workspacePath === 'string' ? stamp.workspacePath : null,
    gitSha: normalizeGitSha(stamp.gitSha),
    gitBranch: typeof stamp.gitBranch === 'string' ? stamp.gitBranch : null,
    workflowHash: normalizeWorkflowHash(stamp.workflowHash),
    providerProfileId: typeof stamp.providerProfileId === 'string' ? stamp.providerProfileId : null,
    generationIndex: normalizePositiveInteger(stamp.generationIndex) ?? 1,
    cycle: normalizePositiveInteger(stamp.cycle) ?? 1,
    capturedAt: normalizePositiveInteger(stamp.capturedAt) ?? Date.now(),
  };
}

function normalizeCheckpoint(checkpoint: MissionCheckpoint): MissionCheckpoint {
  return {
    ...checkpoint,
    attemptId: typeof checkpoint.attemptId === 'string' ? checkpoint.attemptId : null,
    generationIndex: normalizePositiveInteger(checkpoint.generationIndex) ?? 1,
    cycle: normalizePositiveInteger(checkpoint.cycle) ?? 1,
    stage: typeof checkpoint.stage === 'string' && checkpoint.stage.trim().length > 0
      ? checkpoint.stage.trim()
      : 'runtime.unknown',
    summary: typeof checkpoint.summary === 'string' && checkpoint.summary.trim().length > 0
      ? checkpoint.summary.trim()
      : 'Mission checkpoint recorded.',
    payload: isRecord(checkpoint.payload) ? cloneValue(checkpoint.payload) : {},
    createdAt: normalizePositiveInteger(checkpoint.createdAt) ?? Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function normalizeGitSha(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{40,64}$/.test(trimmed) ? trimmed : null;
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const next = cloneValue(items);
  const index = next.findIndex((item) => item.id === value.id);
  if (index === -1) {
    next.push(cloneValue(value));
    return next;
  }
  next[index] = cloneValue(value);
  return next;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
