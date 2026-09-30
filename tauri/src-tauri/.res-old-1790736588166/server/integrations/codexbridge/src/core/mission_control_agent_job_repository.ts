import type {
  ChecklistSnapshot,
  Mission,
  MissionAttempt,
  MissionCheckpoint,
  MissionEnvironmentStamp,
  MissionEvent,
  MissionGeneration,
  MissionRepository,
  PlanChangeRequest,
  WorkItem,
} from '../../packages/mission-control/src/index.js';
import {
  createProjectedMissionRuntimeStateForAgentJob,
} from './mission_control_agent_job_adapter.js';
import {
  buildAgentJobMissionPatch,
  loadMissionRuntimeStateFromJob,
  type AgentJobMissionProjectionState,
} from './mission_control_agent_job_projection.js';
import type {
  AgentJob,
  BridgeSession,
} from '../types/core.js';

export interface AgentJobMissionRepositoryStore {
  listJobs(): AgentJob[];
  getJobById(id: string): AgentJob | null;
  updateJob(id: string, updates: Partial<AgentJob>): AgentJob;
  resolveSession?(job: AgentJob): BridgeSession | null;
}

export interface AgentJobMissionRepositoryOptions {
  now?: () => number;
  materializeMissingState?: boolean;
}

export class AgentJobMissionRepository implements MissionRepository {
  private readonly now: () => number;

  private readonly materializeMissingState: boolean;

  constructor(
    private readonly store: AgentJobMissionRepositoryStore,
    options: AgentJobMissionRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.materializeMissingState = options.materializeMissingState ?? true;
  }

  getMissionById(id: string): Mission | null {
    const job = this.store.getJobById(id);
    return job ? this.ensureRuntimeState(job).mission : null;
  }

  getWorkItemById(id: string): WorkItem | null {
    for (const job of this.store.listJobs()) {
      const workItem = this.ensureRuntimeState(job).workItem;
      if (workItem?.id === id) {
        return cloneValue(workItem);
      }
    }
    return null;
  }

  saveWorkItem(workItem: WorkItem): WorkItem {
    const currentJob = this.store
      .listJobs()
      .find((job) => this.ensureRuntimeState(job).mission?.workItemId === workItem.id);
    if (!currentJob) {
      return workItem;
    }
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      workItem: cloneValue(workItem),
    });
    return workItem;
  }

  listMissions(): Mission[] {
    return this.store
      .listJobs()
      .map((job) => this.ensureRuntimeState(job).mission)
      .filter(Boolean) as Mission[];
  }

  listResumableMissions(now = Date.now()): Mission[] {
    return this.listMissions().filter((mission) => {
      if (!mission.lease) {
        return ['queued', 'planning', 'running', 'verifying', 'repairing', 'handoff'].includes(mission.status);
      }
      return mission.lease.releasedAt !== null || mission.lease.expiresAt <= now;
    });
  }

  saveMission(mission: Mission): Mission {
    const currentJob = this.requireJob(mission.id);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      mission: cloneValue(mission),
    });
    return mission;
  }

  getGenerationById(id: string): MissionGeneration | null {
    for (const job of this.store.listJobs()) {
      const generation = this.ensureRuntimeState(job).generations.find((entry) => entry.id === id);
      if (generation) {
        return cloneValue(generation);
      }
    }
    return null;
  }

  listGenerations(missionId: string): MissionGeneration[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).generations : [];
  }

  saveGeneration(generation: MissionGeneration): MissionGeneration {
    const currentJob = this.requireJob(generation.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      generations: upsertById(currentState.generations, generation).sort((left, right) => left.index - right.index),
    });
    return generation;
  }

  getChecklistSnapshotById(id: string): ChecklistSnapshot | null {
    for (const job of this.store.listJobs()) {
      const snapshot = this.ensureRuntimeState(job).checklistSnapshots.find((entry) => entry.id === id);
      if (snapshot) {
        return cloneValue(snapshot);
      }
    }
    return null;
  }

  listChecklistSnapshots(missionId: string): ChecklistSnapshot[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).checklistSnapshots : [];
  }

  saveChecklistSnapshot(snapshot: ChecklistSnapshot): ChecklistSnapshot {
    const currentJob = this.requireJob(snapshot.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      checklistSnapshots: upsertById(currentState.checklistSnapshots, snapshot)
        .sort((left, right) => left.version - right.version),
    });
    return snapshot;
  }

  getPlanChangeRequestById(id: string): PlanChangeRequest | null {
    for (const job of this.store.listJobs()) {
      const changeRequest = this.ensureRuntimeState(job).planChangeRequests.find((entry) => entry.id === id);
      if (changeRequest) {
        return cloneValue(changeRequest);
      }
    }
    return null;
  }

  listPlanChangeRequests(missionId: string): PlanChangeRequest[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).planChangeRequests : [];
  }

  savePlanChangeRequest(changeRequest: PlanChangeRequest): PlanChangeRequest {
    const currentJob = this.requireJob(changeRequest.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      planChangeRequests: upsertById(currentState.planChangeRequests, changeRequest),
    });
    return changeRequest;
  }

  getAttemptById(id: string): MissionAttempt | null {
    for (const job of this.store.listJobs()) {
      const attempt = this.ensureRuntimeState(job).attempts.find((entry) => entry.id === id);
      if (attempt) {
        return cloneValue(attempt);
      }
    }
    return null;
  }

  listAttempts(missionId: string): MissionAttempt[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).attempts : [];
  }

  saveAttempt(attempt: MissionAttempt): MissionAttempt {
    const currentJob = this.requireJob(attempt.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      attempts: upsertById(currentState.attempts, attempt).sort((left, right) => {
        const leftGeneration = left.generationIndex ?? 0;
        const rightGeneration = right.generationIndex ?? 0;
        if (leftGeneration !== rightGeneration) {
          return leftGeneration - rightGeneration;
        }
        return left.index - right.index;
      }),
    });
    return attempt;
  }

  getEnvironmentStampById(id: string): MissionEnvironmentStamp | null {
    for (const job of this.store.listJobs()) {
      const stamp = this.ensureRuntimeState(job).environmentStamps.find((entry) => entry.id === id);
      if (stamp) {
        return cloneValue(stamp);
      }
    }
    return null;
  }

  listEnvironmentStamps(missionId: string): MissionEnvironmentStamp[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).environmentStamps : [];
  }

  saveEnvironmentStamp(stamp: MissionEnvironmentStamp): MissionEnvironmentStamp {
    const currentJob = this.requireJob(stamp.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      environmentStamps: upsertById(currentState.environmentStamps, stamp)
        .sort((left, right) => left.capturedAt - right.capturedAt),
    });
    return stamp;
  }

  getCheckpointById(id: string): MissionCheckpoint | null {
    for (const job of this.store.listJobs()) {
      const checkpoint = this.ensureRuntimeState(job).checkpoints.find((entry) => entry.id === id);
      if (checkpoint) {
        return cloneValue(checkpoint);
      }
    }
    return null;
  }

  listCheckpoints(missionId: string): MissionCheckpoint[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).checkpoints : [];
  }

  saveCheckpoint(checkpoint: MissionCheckpoint): MissionCheckpoint {
    const currentJob = this.requireJob(checkpoint.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      checkpoints: upsertById(currentState.checkpoints, checkpoint)
        .sort((left, right) => left.createdAt - right.createdAt),
    });
    return checkpoint;
  }

  listEvents(missionId: string): MissionEvent[] {
    const job = this.store.getJobById(missionId);
    return job ? this.ensureRuntimeState(job).events : [];
  }

  appendEvent(event: MissionEvent): MissionEvent {
    const currentJob = this.requireJob(event.missionId);
    const currentState = this.ensureRuntimeState(currentJob);
    this.persistState(currentJob, {
      ...currentState,
      events: [...currentState.events, cloneValue(event)],
    });
    return event;
  }

  resetMission(mission: Mission): Mission {
    const currentJob = this.requireJob(mission.id);
    this.persistState(currentJob, {
      workItem: null,
      mission: cloneValue(mission),
      generations: [],
      checklistSnapshots: [],
      planChangeRequests: [],
      attempts: [],
      environmentStamps: [],
      checkpoints: [],
      events: [],
    });
    return mission;
  }

  private requireJob(id: string): AgentJob {
    const job = this.store.getJobById(id);
    if (!job) {
      throw new Error(`Unknown agent job: ${id}`);
    }
    return job;
  }

  private ensureRuntimeState(job: AgentJob): AgentJobMissionProjectionState {
    const state = loadMissionRuntimeStateFromJob(job);
    if (state.mission || !this.materializeMissingState) {
      return state;
    }
    const synthesized = createProjectedMissionRuntimeStateForAgentJob(job, {
      now: this.now(),
      codexThreadId: this.store.resolveSession?.(job)?.codexThreadId ?? null,
    });
    this.persistState(job, synthesized);
    return synthesized;
  }

  private persistState(job: AgentJob, state: AgentJobMissionProjectionState): AgentJob {
    const patch = buildAgentJobMissionPatch(job, state);
    return this.store.updateJob(job.id, patch);
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const next = items.map((item) => cloneValue(item));
  const index = next.findIndex((item) => item.id === value.id);
  if (index === -1) {
    next.push(cloneValue(value));
    return next;
  }
  next[index] = cloneValue(value);
  return next;
}
