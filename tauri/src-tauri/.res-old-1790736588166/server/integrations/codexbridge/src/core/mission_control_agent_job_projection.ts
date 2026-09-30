import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionGeneration,
  MissionProviderArtifact,
  MissionRepository,
  MissionStatus,
  PlanChangeRequest,
  WorkItem,
} from '../../packages/mission-control/src/index.js';
import {
  loadAgentJobMissionRuntimeState,
  serializeAgentJobMissionRuntimeState,
  type AgentJobMissionRuntimeStateView,
} from './mission_control_agent_job_adapter.js';
import type {
  AgentJob,
  AgentJobAttemptHistoryEntry,
  AgentJobMissionRuntimeState,
  AgentJobStatus,
  TurnArtifactDeliveredItem,
} from '../types/core.js';

const ACTIVE_MISSION_JOB_STATUS_SET = new Set<MissionStatus>([
  'planning',
  'running',
  'verifying',
  'repairing',
]);

const TERMINAL_MISSION_JOB_STATUS_SET = new Set<MissionStatus>([
  'max_loops_reached',
  'completed',
  'failed',
  'stopped',
  'archived',
]);

export type AgentJobMissionProjectionState = AgentJobMissionRuntimeStateView;

export function loadMissionRuntimeStateFromJob(job: AgentJob): AgentJobMissionProjectionState {
  return loadAgentJobMissionRuntimeState(job);
}

export function serializeMissionRuntimeState(
  state: AgentJobMissionProjectionState,
): AgentJobMissionRuntimeState {
  return serializeAgentJobMissionRuntimeState(state);
}

export function readMissionRuntimeStateFromRepository(
  repository: MissionRepository,
  missionId: string,
): AgentJobMissionProjectionState {
  const mission = repository.getMissionById(missionId);
  if (!mission) {
    return emptyMissionRuntimeState();
  }
  return {
    workItem: repository.getWorkItemById(mission.workItemId),
    mission,
    generations: repository.listGenerations(missionId).sort((left, right) => left.index - right.index),
    checklistSnapshots: repository.listChecklistSnapshots(missionId).sort((left, right) => left.version - right.version),
    planChangeRequests: repository.listPlanChangeRequests(missionId).sort((left, right) => left.createdAt - right.createdAt),
    attempts: sortAttempts(repository.listAttempts(missionId)),
    environmentStamps: repository.listEnvironmentStamps(missionId).sort((left, right) => left.capturedAt - right.capturedAt),
    checkpoints: repository.listCheckpoints(missionId).sort((left, right) => left.createdAt - right.createdAt),
    events: repository.listEvents(missionId).sort((left, right) => left.createdAt - right.createdAt),
  };
}

export function persistMissionRuntimeStateToRepository(
  repository: MissionRepository,
  state: AgentJobMissionProjectionState,
): void {
  if (state.workItem) {
    repository.saveWorkItem(state.workItem);
  }
  if (!state.mission) {
    return;
  }
  repository.resetMission(state.mission);
  if (state.workItem) {
    repository.saveWorkItem(state.workItem);
  }
  for (const generation of state.generations) {
    repository.saveGeneration(generation);
  }
  for (const snapshot of state.checklistSnapshots) {
    repository.saveChecklistSnapshot(snapshot);
  }
  for (const changeRequest of state.planChangeRequests) {
    repository.savePlanChangeRequest(changeRequest);
  }
  for (const attempt of sortAttempts(state.attempts)) {
    repository.saveAttempt(attempt);
  }
  for (const stamp of state.environmentStamps.slice().sort((left, right) => left.capturedAt - right.capturedAt)) {
    repository.saveEnvironmentStamp(stamp);
  }
  for (const checkpoint of state.checkpoints.slice().sort((left, right) => left.createdAt - right.createdAt)) {
    repository.saveCheckpoint(checkpoint);
  }
  for (const event of state.events.slice().sort((left, right) => left.createdAt - right.createdAt)) {
    repository.appendEvent(event);
  }
}

export function buildAgentJobMissionPatch(
  job: AgentJob,
  state: AgentJobMissionProjectionState,
  options: {
    includeRuntimeState?: boolean;
  } = {},
): Partial<AgentJob> {
  const mission = state.mission;
  if (!mission) {
    return {
      missionRuntimeState: options.includeRuntimeState === false
        ? job.missionRuntimeState
        : null,
      missionAttemptHistory: [],
    };
  }
  const attempts = sortAttempts(state.attempts);
  return {
    status: mapMissionStatusToAgentJobStatus(mission.status),
    running: ACTIVE_MISSION_JOB_STATUS_SET.has(mission.status),
    stopRequested: Boolean(mission.stopRequest) || mission.status === 'stopped',
    attemptCount: mission.attemptCount,
    lastRunAt: mission.lastRunAt,
    completedAt: TERMINAL_MISSION_JOB_STATUS_SET.has(mission.status)
      ? (mission.completedAt ?? mission.stoppedAt ?? mission.updatedAt)
      : null,
    lastResultPreview: summarizeMissionPreview(mission.lastResultPreview, mission.resultArtifacts),
    resultText: mission.resultText,
    resultArtifacts: mapMissionArtifactsToAgentArtifacts(mission.resultArtifacts),
    lastError: mission.lastError,
    verificationSummary: mission.workpad.latestVerifierSummary,
    missionWorkflowPath: mission.workflowPath,
    missionWorkflowSourceLabel: mission.workflowPath
      ? `configured workflow (${mission.workflowPath})`
      : job.missionWorkflowSourceLabel,
    missionWorkpadLatestBlocker: mission.workpad.latestBlocker,
    missionWorkpadLatestVerifierSummary: mission.workpad.latestVerifierSummary,
    missionWorkpadFinalResultSummary: mission.workpad.finalResultSummary ?? mission.lastResultPreview,
    missionAttemptHistory: buildAttemptHistory(attempts),
    missionRuntimeState: options.includeRuntimeState === false
      ? job.missionRuntimeState
      : serializeMissionRuntimeState(state),
  };
}

export function emptyMissionRuntimeState(): AgentJobMissionProjectionState {
  return {
    workItem: null,
    mission: null,
    generations: [],
    checklistSnapshots: [],
    planChangeRequests: [],
    attempts: [],
    environmentStamps: [],
    checkpoints: [],
    events: [],
  };
}

function sortAttempts(attempts: MissionAttempt[]): MissionAttempt[] {
  return attempts
    .slice()
    .sort((left, right) => {
      const leftGeneration = left.generationIndex ?? 0;
      const rightGeneration = right.generationIndex ?? 0;
      if (leftGeneration !== rightGeneration) {
        return leftGeneration - rightGeneration;
      }
      return left.index - right.index;
    });
}

function buildAttemptHistory(attempts: MissionAttempt[]): AgentJobAttemptHistoryEntry[] {
  return attempts.map((attempt) => ({
    attempt: attempt.index,
    status: mapMissionAttemptStatusToAgentJobStatus(attempt.status),
    verifierSummary: attempt.verifierSummary,
    outputPreview: attempt.outputPreview,
    error: attempt.error,
    recordedAt: attempt.endedAt ?? attempt.updatedAt,
  }));
}

function mapMissionStatusToAgentJobStatus(status: MissionStatus): AgentJobStatus {
  switch (status) {
    case 'draft':
    case 'awaiting_checklist_confirm':
      return 'awaiting_checklist_confirm';
    case 'awaiting_prompt_confirm':
      return 'awaiting_prompt_confirm';
    case 'queued':
    case 'planning':
    case 'running':
    case 'verifying':
    case 'repairing':
    case 'waiting_user':
    case 'needs_human':
    case 'scope_change_pending':
    case 'handoff':
    case 'blocked':
    case 'max_loops_reached':
    case 'completed':
    case 'failed':
    case 'stopped':
      return status;
    case 'archived':
      return 'completed';
  }
}

function mapMissionAttemptStatusToAgentJobStatus(status: MissionAttempt['status']): AgentJobStatus {
  switch (status) {
    case 'queued':
    case 'running':
    case 'verifying':
    case 'repairing':
    case 'waiting_user':
    case 'needs_human':
    case 'handoff':
    case 'blocked':
    case 'completed':
    case 'failed':
    case 'stopped':
      return status;
  }
}

function summarizeMissionPreview(value: string | null, artifacts: unknown[]): string | null {
  const text = compactString(value);
  if (text) {
    return text.length > 180 ? `${text.slice(0, 179)}…` : text;
  }
  const artifactCount = Array.isArray(artifacts) ? artifacts.length : 0;
  return artifactCount > 0 ? `attachments: ${artifactCount}` : null;
}

function mapMissionArtifactsToAgentArtifacts(value: unknown[]): TurnArtifactDeliveredItem[] | null {
  const normalized = value
    .map((artifact) => {
      const type = compactString((artifact as MissionProviderArtifact | null)?.type);
      const path = compactString((artifact as MissionProviderArtifact | null)?.path);
      if (!type || !path) {
        return null;
      }
      return {
        kind: type === 'other' ? 'file' : (type as TurnArtifactDeliveredItem['kind']),
        path,
        displayName: compactString((artifact as MissionProviderArtifact | null)?.name),
        mimeType: compactString((artifact as MissionProviderArtifact | null)?.mimeType),
        sizeBytes: null,
        caption: compactString((artifact as MissionProviderArtifact | null)?.caption),
        source: 'provider_native' as const,
        turnId: null,
      };
    })
    .filter(Boolean) as TurnArtifactDeliveredItem[];
  return normalized.length > 0 ? normalized : null;
}

function compactString(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionGeneration,
  PlanChangeRequest,
  WorkItem,
};
