import { getLatestMissionCycleResult, type MissionCycleResult } from './cycle_result.js';
import { MissionLeaseCoordinator } from './lease_coordinator.js';
import type { MissionRepository } from './repository.js';
import { materializeMissionStop, resolveMissionStopReason } from './control_actions.js';
import { isMissionResumable } from './state_machine.js';
import type { MissionRunOptions, MissionRunResult, MissionRuntime } from './runtime.js';
import type {
  Mission,
  MissionAttempt,
  MissionEvent,
  MissionPendingApproval,
  MissionStopRequest,
  MissionStatus,
} from './types.js';

const SUPERVISABLE_MISSION_STATUS_SET = new Set<MissionStatus>([
  'queued',
  'planning',
  'running',
  'verifying',
  'repairing',
]);

export interface MissionSupervisionSnapshot {
  missionId: string;
  status: MissionStatus;
  resumable: boolean;
  supervisable: boolean;
  stopRequest: MissionStopRequest | null;
  activeGenerationId: string;
  activeGenerationIndex: number;
  activeAttemptId: string | null;
  activeAttemptStatus: MissionAttempt['status'] | null;
  attemptCount: number;
  eventCount: number;
  latestCycleResult: MissionCycleResult | null;
  summary: string | null;
  latestBlocker: string | null;
  latestVerifierSummary: string | null;
  finalResultSummary: string | null;
  lastResultPreview: string | null;
  lastError: string | null;
  pendingApproval: MissionPendingApproval | null;
  workflowPath: string | null;
  workspacePath: string | null;
  lastEventAt: number | null;
  updatedAt: number;
}

export interface ListSupervisableMissionOptions {
  missionIds?: string[] | null;
  now?: number;
}

export interface MissionSupervisorCycleRecord {
  cycle: number;
  missionId: string;
  before: MissionSupervisionSnapshot;
  after: MissionSupervisionSnapshot;
  progress: boolean;
  runResult: MissionRunResult;
}

export type MissionSupervisorStopReason =
  | 'idle'
  | 'max_cycles_reached'
  | 'max_no_progress_cycles_reached';

export interface MissionSupervisorRunReport {
  stopReason: MissionSupervisorStopReason;
  recoveredMissionIds: string[];
  stoppedMissionIds: string[];
  noProgressCycles: number;
  cycles: MissionSupervisorCycleRecord[];
  remainingMissionIds: string[];
}

export interface MissionSupervisorRunOptions extends MissionRunOptions {
  missionIds?: string[] | null;
  maxCycles?: number | null;
  maxNoProgressCycles?: number | null;
  recoverStaleBeforeRun?: boolean;
}

export interface MissionSupervisorOptions {
  repository: MissionRepository;
  runtime?: MissionRuntime | null;
  leaseCoordinator?: MissionLeaseCoordinator;
  now?: () => number;
}

export class MissionSupervisor {
  private readonly repository: MissionRepository;

  private readonly runtime: MissionRuntime | null;

  private readonly leaseCoordinator: MissionLeaseCoordinator;

  private readonly now: () => number;

  constructor({
    repository,
    runtime = null,
    leaseCoordinator = new MissionLeaseCoordinator(repository),
    now = () => Date.now(),
  }: MissionSupervisorOptions) {
    this.repository = repository;
    this.runtime = runtime;
    this.leaseCoordinator = leaseCoordinator;
    this.now = now;
  }

  createSnapshot(missionId: string): MissionSupervisionSnapshot | null {
    const mission = this.repository.getMissionById(missionId);
    return mission ? createMissionSupervisionSnapshot(this.repository, mission, this.now()) : null;
  }

  listSupervisableMissionIds(
    options: ListSupervisableMissionOptions = {},
  ): string[] {
    const now = typeof options.now === 'number' ? options.now : this.now();
    const missionIds = normalizeMissionIdSet(options.missionIds);
    return this.repository
      .listMissions()
      .filter((mission) => missionIds === null || missionIds.has(mission.id))
      .filter((mission) => isMissionSupervisable(this.repository, mission, now))
      .sort(compareMissionsForSupervision)
      .map((mission) => mission.id);
  }

  recoverStaleMissions(now = this.now()): Mission[] {
    return this.leaseCoordinator.recoverStaleMissions(now);
  }

  reconcileStopRequestedMissions(ownerId: string, now = this.now()): Mission[] {
    const stopped: Mission[] = [];
    for (const mission of this.repository.listMissions()) {
      if (!mission.stopRequest) {
        continue;
      }
      if (!canSupervisorMaterializeStop(mission, now)) {
        continue;
      }
      const reason = resolveMissionStopReason(mission);
      let attempt = mission.activeAttemptId
        ? this.repository.getAttemptById(mission.activeAttemptId)
        : findLatestStoppableAttempt(this.repository, mission.id);
      if (attempt && !isTerminalAttemptStatus(attempt.status)) {
        attempt = this.repository.saveAttempt({
          ...attempt,
          status: 'stopped',
          error: reason,
          endedAt: attempt.endedAt ?? now,
          updatedAt: now,
        });
        this.repository.appendEvent({
          id: `mission-stop:${mission.id}:attempt:${now}`,
          missionId: mission.id,
          attemptId: attempt.id,
          generationId: attempt.generationId ?? mission.activeGenerationId,
          generationIndex: attempt.generationIndex ?? mission.activeGenerationIndex,
          kind: 'attempt.stopped',
          summary: reason,
          detail: null,
          metadata: {
            stopRequestId: mission.stopRequest.requestId,
            actorId: mission.stopRequest.actorId,
            actorType: mission.stopRequest.actorType,
            supervisor: true,
          },
          createdAt: now,
        });
      }
      let stoppedMission = materializeMissionStop(mission, {
        at: now,
        reason,
        lastError: reason,
        activeAttemptId: attempt?.id ?? mission.activeAttemptId,
      });
      this.repository.saveMission(stoppedMission);
      this.repository.appendEvent({
        id: `mission-stop:${mission.id}:mission:${now}`,
        missionId: mission.id,
        attemptId: attempt?.id ?? null,
        generationId: mission.activeGenerationId,
        generationIndex: mission.activeGenerationIndex,
        kind: 'mission.stopped',
        summary: reason,
        detail: null,
        metadata: {
          stopRequestId: mission.stopRequest.requestId,
          actorId: mission.stopRequest.actorId,
          actorType: mission.stopRequest.actorType,
          ownerId,
          supervisor: true,
        },
        createdAt: now,
      });
      stoppedMission = this.leaseCoordinator.releaseMission(stoppedMission.id, {
        ownerId,
        reason,
      });
      stopped.push(stoppedMission);
    }
    return stopped;
  }

  async runUntilIdle(
    options: MissionSupervisorRunOptions,
  ): Promise<MissionSupervisorRunReport> {
    if (!this.runtime) {
      throw new Error('MissionSupervisor requires a MissionRuntime to dispatch missions.');
    }
    const report: MissionSupervisorRunReport = {
      stopReason: 'idle',
      recoveredMissionIds: [],
      stoppedMissionIds: [],
      noProgressCycles: 0,
      cycles: [],
      remainingMissionIds: [],
    };
    if (options.recoverStaleBeforeRun !== false) {
      this.appendRecoveredMissionIds(report, this.recoverStaleMissions());
    }
    this.appendStoppedMissionIds(report, this.reconcileStopRequestedMissions(options.ownerId));

    const maxCycles = normalizePositiveInteger(options.maxCycles) ?? Number.POSITIVE_INFINITY;
    const maxNoProgressCycles = normalizePositiveInteger(options.maxNoProgressCycles) ?? Number.POSITIVE_INFINITY;
    let noProgressCycles = 0;

    while (report.cycles.length < maxCycles) {
      const nextMissionId = this.listSupervisableMissionIds({
        missionIds: options.missionIds,
      })[0] ?? null;
      if (!nextMissionId) {
        report.stopReason = 'idle';
        report.noProgressCycles = noProgressCycles;
        report.remainingMissionIds = [];
        return report;
      }

      const before = this.requireSnapshot(nextMissionId);
      const runResult = await this.runtime.runMission(nextMissionId, options);
      const after = this.requireSnapshot(nextMissionId);
      const progress = didMissionSupervisionProgress(before, after);
      report.cycles.push({
        cycle: report.cycles.length + 1,
        missionId: nextMissionId,
        before,
        after,
        progress,
        runResult,
      });

      noProgressCycles = progress ? 0 : noProgressCycles + 1;
      if (noProgressCycles >= maxNoProgressCycles) {
        report.stopReason = 'max_no_progress_cycles_reached';
        break;
      }

      if (options.recoverStaleBeforeRun !== false) {
        this.appendRecoveredMissionIds(report, this.recoverStaleMissions());
      }
      this.appendStoppedMissionIds(report, this.reconcileStopRequestedMissions(options.ownerId));
    }

    if (report.stopReason !== 'max_no_progress_cycles_reached') {
      report.stopReason = 'max_cycles_reached';
    }
    report.noProgressCycles = noProgressCycles;
    report.remainingMissionIds = this.listSupervisableMissionIds({
      missionIds: options.missionIds,
    });
    return report;
  }

  private appendRecoveredMissionIds(
    report: MissionSupervisorRunReport,
    missions: readonly Mission[],
  ): void {
    for (const mission of missions) {
      if (!report.recoveredMissionIds.includes(mission.id)) {
        report.recoveredMissionIds.push(mission.id);
      }
    }
  }

  private appendStoppedMissionIds(
    report: MissionSupervisorRunReport,
    missions: readonly Mission[],
  ): void {
    for (const mission of missions) {
      if (!report.stoppedMissionIds.includes(mission.id)) {
        report.stoppedMissionIds.push(mission.id);
      }
    }
  }

  private requireSnapshot(missionId: string): MissionSupervisionSnapshot {
    const snapshot = this.createSnapshot(missionId);
    if (!snapshot) {
      throw new Error(`unknown mission: ${missionId}`);
    }
    return snapshot;
  }
}

export function createMissionSupervisionSnapshot(
  repository: MissionRepository,
  mission: Mission,
  now = Date.now(),
): MissionSupervisionSnapshot {
  const attempt = mission.activeAttemptId ? repository.getAttemptById(mission.activeAttemptId) : null;
  const events = repository.listEvents(mission.id);
  const latestEvent = getLatestMissionEvent(events);
  return {
    missionId: mission.id,
    status: mission.status,
    resumable: isMissionResumable(mission, now),
    supervisable: isMissionSupervisable(repository, mission, now),
    stopRequest: cloneStopRequest(mission.stopRequest),
    activeGenerationId: mission.activeGenerationId,
    activeGenerationIndex: mission.activeGenerationIndex,
    activeAttemptId: mission.activeAttemptId,
    activeAttemptStatus: attempt?.status ?? null,
    attemptCount: mission.attemptCount,
    eventCount: events.length,
    latestCycleResult: getLatestMissionCycleResult(events),
    summary: mission.workpad.summary,
    latestBlocker: mission.workpad.latestBlocker,
    latestVerifierSummary: mission.workpad.latestVerifierSummary,
    finalResultSummary: mission.workpad.finalResultSummary,
    lastResultPreview: mission.lastResultPreview,
    lastError: mission.lastError,
    pendingApproval: mission.pendingApproval,
    workflowPath: mission.workflowPath,
    workspacePath: mission.workspacePath,
    lastEventAt: latestEvent?.createdAt ?? null,
    updatedAt: mission.updatedAt,
  };
}

export function isMissionSupervisable(
  repository: MissionRepository,
  mission: Mission,
  now = Date.now(),
): boolean {
  if (mission.stopRequest) {
    return false;
  }
  if (!SUPERVISABLE_MISSION_STATUS_SET.has(mission.status)) {
    return false;
  }
  if (!isMissionResumable(mission, now)) {
    return false;
  }
  const activeAttempt = mission.activeAttemptId ? repository.getAttemptById(mission.activeAttemptId) : null;
  switch (mission.status) {
    case 'queued':
    case 'planning':
      return true;
    case 'running':
      return activeAttempt === null
        || (activeAttempt.status === 'running' && activeAttempt.startedAt === null);
    case 'verifying':
    case 'repairing':
      return activeAttempt !== null;
    default:
      return false;
  }
}

export function didMissionSupervisionProgress(
  before: MissionSupervisionSnapshot,
  after: MissionSupervisionSnapshot,
): boolean {
  if (after.eventCount > before.eventCount) {
    return true;
  }
  if (after.attemptCount > before.attemptCount) {
    return true;
  }
  if (after.status !== before.status) {
    return true;
  }
  if ((after.latestCycleResult?.cycle ?? 0) > (before.latestCycleResult?.cycle ?? 0)) {
    return true;
  }
  if ((after.latestCycleResult?.overallCompletion ?? -1) > (before.latestCycleResult?.overallCompletion ?? -1)) {
    return true;
  }
  return false;
}

function compareMissionsForSupervision(left: Mission, right: Mission): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id.localeCompare(right.id);
}

function getLatestMissionEvent(events: readonly MissionEvent[]): MissionEvent | null {
  let latest: MissionEvent | null = null;
  for (const event of events) {
    if (!latest || event.createdAt > latest.createdAt) {
      latest = event;
    }
  }
  return latest;
}

function cloneStopRequest(value: MissionStopRequest | null): MissionStopRequest | null {
  if (!value) {
    return null;
  }
  return {
    ...value,
  };
}

function canSupervisorMaterializeStop(mission: Mission, now: number): boolean {
  if (!mission.stopRequest) {
    return false;
  }
  if (
    mission.status === 'draft'
    || mission.status === 'queued'
    || mission.status === 'waiting_user'
    || mission.status === 'needs_human'
    || mission.status === 'handoff'
    || mission.status === 'blocked'
  ) {
    return true;
  }
  if (
    mission.status !== 'planning'
    && mission.status !== 'running'
    && mission.status !== 'verifying'
    && mission.status !== 'repairing'
  ) {
    return false;
  }
  return mission.lease === null
    || mission.lease.releasedAt !== null
    || mission.lease.expiresAt <= now;
}

function isTerminalAttemptStatus(status: MissionAttempt['status']): boolean {
  return (
    status === 'completed'
    || status === 'failed'
    || status === 'stopped'
    || status === 'waiting_user'
    || status === 'needs_human'
    || status === 'handoff'
    || status === 'blocked'
  );
}

function findLatestStoppableAttempt(
  repository: MissionRepository,
  missionId: string,
): MissionAttempt | null {
  const attempts = repository.listAttempts(missionId)
    .filter((attempt) => !isTerminalAttemptStatus(attempt.status))
    .sort((left, right) => {
      const leftGeneration = left.generationIndex ?? 0;
      const rightGeneration = right.generationIndex ?? 0;
      if (leftGeneration !== rightGeneration) {
        return rightGeneration - leftGeneration;
      }
      if (left.index !== right.index) {
        return right.index - left.index;
      }
      return right.updatedAt - left.updatedAt;
    });
  return attempts[0] ?? null;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function normalizeMissionIdSet(values: string[] | null | undefined): Set<string> | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const ids = values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}
